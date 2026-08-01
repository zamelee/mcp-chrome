"""
test_bundles.py

Patch 5 of 6 (agentify-sh/desktop deep-dive, plan section 2.5).

Unit tests for tools/bundles.py:
  - normalize_bundle validation (accept well-formed, reject malformed)
  - load_bundle reads from BUNDLES_DIR, raises BundleNotFoundError on miss
  - list_bundles discovers JSON files in BUNDLES_DIR (excludes AGENTS.md)
  - merge_bundle_with_args: bundle first, dedup, prefix joining
  - reset_cache invalidates module-level cache
  - chatgpt_consult --bundle integration smoke (--bundle NAME + nonexistent)

Adapted from agentify-sh/desktop (design only, implementation original).
"""
import os, sys, json, tempfile
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import bundles


class TestNormalizeBundle:
    def setup_method(self):
        bundles.reset_cache()

    def test_accepts_well_formed(self):
        data = {
            "name": "test-bundle",
            "promptPrefix": "Be precise.",
            "attachments": [r"C:/abs/path/file1.md"],
            "contextPaths": [r"C:/abs/dir"],
            "createdAt": "2026-08-01T00:00:00Z",
        }
        out = bundles.normalize_bundle(data)
        assert out["name"] == "test-bundle"
        assert out["promptPrefix"] == "Be precise."
        assert out["attachments"] == [r"C:/abs/path/file1.md"]
        assert out["contextPaths"] == [r"C:/abs/dir"]

    def test_accepts_minimal(self):
        data = {"name": "min"}
        out = bundles.normalize_bundle(data)
        assert out["name"] == "min"
        assert out["promptPrefix"] == ""
        assert out["attachments"] == []
        assert out["contextPaths"] == []

    def test_rejects_non_dict(self):
        try:
            bundles.normalize_bundle("not a dict")
        except bundles.BundleValidationError as e:
            assert "JSON object" in str(e)
        else:
            assert False, "should have raised"

    def test_rejects_blank_name(self):
        try:
            bundles.normalize_bundle({"name": "   "})
        except bundles.BundleValidationError as e:
            assert "non-empty" in str(e)
        else:
            assert False, "should have raised"

    def test_rejects_bad_name_chars(self):
        for bad_name in ["../etc/passwd", "name with space", "name/with/slash", "中文名"]:
            try:
                bundles.normalize_bundle({"name": bad_name})
            except bundles.BundleValidationError as e:
                assert "must match" in str(e)
            else:
                assert False, "name " + repr(bad_name) + " should have raised"

    def test_rejects_relative_attachments(self):
        try:
            bundles.normalize_bundle({"name": "x", "attachments": ["relative/path.md"]})
        except bundles.BundleValidationError as e:
            assert "absolute" in str(e)
        else:
            assert False, "should have raised"

    def test_rejects_non_string_attachment(self):
        try:
            bundles.normalize_bundle({"name": "x", "attachments": [42]})
        except bundles.BundleValidationError as e:
            assert "non-empty string" in str(e)
        else:
            assert False, "should have raised"

    def test_rejects_blank_attachment(self):
        try:
            bundles.normalize_bundle({"name": "x", "attachments": ["C:/abs/file", "  "]})
        except bundles.BundleValidationError as e:
            assert "non-empty" in str(e)
        else:
            assert False, "should have raised"

    def test_accepts_alternative_keys(self):
        # prompt_prefix / promptPrefix and context_paths / contextPaths both accepted.
        data = {"name": "alt", "prompt_prefix": "PFX", "context_paths": [r"C:/abs"]}
        out = bundles.normalize_bundle(data)
        assert out["promptPrefix"] == "PFX"
        assert out["contextPaths"] == [r"C:/abs"]


class TestLoadBundle:
    def setup_method(self):
        bundles.reset_cache()

    def test_load_real_repo_review_bundle(self):
        bundle = bundles.load_bundle("repo-review")
        assert bundle["name"] == "repo-review"
        assert "Review the repository carefully" in bundle["promptPrefix"]
        assert len(bundle["attachments"]) >= 2
        assert len(bundle["contextPaths"]) >= 2
        for p in bundle["attachments"]:
            assert os.path.isabs(p)
        for p in bundle["contextPaths"]:
            assert os.path.isabs(p)

    def test_load_real_architecture_doc_bundle(self):
        bundle = bundles.load_bundle("architecture-doc")
        assert bundle["name"] == "architecture-doc"
        assert "architecture" in bundle["promptPrefix"].lower()
        assert len(bundle["contextPaths"]) >= 3

    def test_load_missing_bundle_raises(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                bundles.load_bundle("does-not-exist-xyz", bundles_dir=tmpdir, use_cache=False)
            except bundles.BundleNotFoundError as e:
                assert e.name == "does-not-exist-xyz"
                assert e.searched_dir == tmpdir
            else:
                assert False, "should have raised BundleNotFoundError"

    def test_load_with_custom_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            custom = os.path.join(tmpdir, "my-bundle.json")
            with open(custom, "w", encoding="utf-8") as f:
                json.dump({"name": "my-bundle", "attachments": [r"C:/abs"]}, f)
            bundle = bundles.load_bundle("my-bundle", bundles_dir=tmpdir, use_cache=False)
            assert bundle["name"] == "my-bundle"

    def test_load_via_invalid_filename_raises(self):
        # Filename must be exactly {name}.json. Loading with mismatch raises.
        with tempfile.TemporaryDirectory() as tmpdir:
            wrong_name = os.path.join(tmpdir, "foo.json")
            with open(wrong_name, "w", encoding="utf-8") as f:
                json.dump({"name": "bar"}, f)
            try:
                bundles.load_bundle("bar", bundles_dir=tmpdir, use_cache=False)
            except bundles.BundleNotFoundError:
                pass
            else:
                assert False, "should have raised BundleNotFoundError"


class TestListBundles:
    def setup_method(self):
        bundles.reset_cache()

    def test_lists_shipped_bundles(self):
        names = bundles.list_bundles()
        assert "repo-review" in names
        assert "architecture-doc" in names
        # AGENTS.md is NOT a bundle (excluded by list_bundles)
        assert "AGENTS.md" not in names

    def test_lists_returns_sorted(self):
        names = bundles.list_bundles()
        assert names == sorted(names)

    def test_empty_dir_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            assert bundles.list_bundles(bundles_dir=tmpdir) == []

    def test_excludes_underscore_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "_skip.json"), "w") as f:
                f.write("{}")
            with open(os.path.join(tmpdir, "real.json"), "w") as f:
                f.write("{}")
            names = bundles.list_bundles(bundles_dir=tmpdir)
            assert "real" in names
            assert "_skip" not in names


class TestMergeBundleWithArgs:
    def setup_method(self):
        bundles.reset_cache()

    def test_bundle_only_no_cli(self):
        bundle = {
            "name": "x",
            "promptPrefix": "Bundle prefix.",
            "attachments": [r"C:/a"],
            "contextPaths": [r"C:/b"],
        }
        out = bundles.merge_bundle_with_args(bundle, prompt_text="Hello")
        assert out["prompt"] == "Bundle prefix." + chr(10) + "Hello"
        assert out["attachments"] == [r"C:/a"]
        assert out["contextPaths"] == [r"C:/b"]

    def test_cli_only_no_bundle(self):
        bundle = {"name": "x", "attachments": [], "contextPaths": [], "promptPrefix": ""}
        out = bundles.merge_bundle_with_args(bundle, prompt_text="hi", attachments=[r"C:/cli-a"], context_paths=[r"C:/cli-d"])
        assert out["prompt"] == "hi"
        assert out["attachments"] == [r"C:/cli-a"]
        assert out["contextPaths"] == [r"C:/cli-d"]

    def test_bundle_first_cli_after_with_dedup(self):
        bundle = {"name": "x", "attachments": [r"C:/a", r"C:/b"], "contextPaths": [r"C:/d"], "promptPrefix": "B"}
        out = bundles.merge_bundle_with_args(bundle, prompt_text="P", attachments=[r"C:/b", r"C:/c"], context_paths=[r"C:/d", r"C:/e"], prompt_prefix="C")
        # Order: bundle first, then CLI, dedup preserves first-seen.
        assert out["attachments"] == [r"C:/a", r"C:/b", r"C:/c"]
        assert out["contextPaths"] == [r"C:/d", r"C:/e"]
        # Prefix: bundle.promptPrefix first, CLI second, newline-joined.
        assert out["promptPrefix"] == "B" + chr(10) + "C"
        # Final prompt: prefix + body.
        assert out["prompt"] == "B" + chr(10) + "C" + chr(10) + "P"

    def test_empty_bundle(self):
        bundle = {"name": "x", "attachments": [], "contextPaths": [], "promptPrefix": ""}
        out = bundles.merge_bundle_with_args(bundle, prompt_text="")
        assert out["prompt"] == ""
        assert out["attachments"] == []
        assert out["contextPaths"] == []

    def test_whitespace_prefixes_stripped(self):
        bundle = {"name": "x", "promptPrefix": "   B   ", "attachments": [], "contextPaths": []}
        out = bundles.merge_bundle_with_args(bundle, prompt_text="P", prompt_prefix="   C   ")
        assert out["promptPrefix"] == "B" + chr(10) + "C"
        assert out["prompt"] == "B" + chr(10) + "C" + chr(10) + "P"


class TestChatgptConsultBundleIntegration:
    def setup_method(self):
        bundles.reset_cache()

    def test_help_lists_bundle_flag(self):
        r = subprocess.run([sys.executable, "tools/chatgpt_consult.py", "--help"],
                           capture_output=True, text=True, cwd=os.path.dirname(_HERE))
        assert r.returncode == 0
        assert "--bundle BUNDLE" in r.stdout
        assert "--prompt-prefix" in r.stdout
        assert "--attachment" in r.stdout
        assert "--context-path" in r.stdout

    def test_unknown_bundle_exits_with_code_8(self):
        # Write a dummy prompt file, then invoke --bundle with a missing name.
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
            f.write("dummy prompt body")
            prompt_path = f.name
        try:
            r = subprocess.run(
                [sys.executable, "tools/chatgpt_consult.py", "--bundle", "no-such-bundle-xyz", prompt_path],
                capture_output=True, text=True, cwd=os.path.dirname(_HERE),
            )
            assert r.returncode == 8, "expected exit code 8, got " + str(r.returncode)
            assert "FATAL: bundle" in r.stderr
            assert "not found" in r.stderr
            assert "no-such-bundle-xyz" in r.stderr
        finally:
            os.unlink(prompt_path)

    def test_merge_end_to_end_with_real_bundle(self):
        # Verify that calling merge_bundle_with_args with the shipped repo-review bundle
        # produces a valid prompt (real end-to-end without launching Chrome).
        bundle = bundles.load_bundle("repo-review")
        out = bundles.merge_bundle_with_args(
            bundle,
            prompt_text="Please focus on the auth flow.",
            attachments=[r"C:/additional/file.md"],
            context_paths=[r"C:/additional/dir"],
        )
        assert "Please focus on the auth flow." in out["prompt"]
        assert bundle["promptPrefix"].split(".")[0] in out["prompt"]
        # Bundle attachments come first, then CLI-added.
        first_attachment = out["attachments"][0]
        assert first_attachment in bundle["attachments"]
        # The CLI-added attachment is in the list (could be at any position after dedup).
        assert r"C:/additional/file.md" in out["attachments"]


class TestCache:
    def setup_method(self):
        bundles.reset_cache()

    def test_cache_returns_same_dict_object(self):
        a = bundles.load_bundle("repo-review")
        b = bundles.load_bundle("repo-review")
        assert a is b

    def test_reset_cache_forces_reload(self):
        a = bundles.load_bundle("repo-review")
        bundles.reset_cache()
        b = bundles.load_bundle("repo-review")
        assert a is not b
        assert a == b


class TestExceptions:
    def test_BundleNotFoundError_is_KeyError(self):
        # BundleNotFoundError subclasses KeyError so existing except KeyError catches it.
        e = bundles.BundleNotFoundError("foo", "/tmp")
        assert isinstance(e, KeyError)
        assert e.name == "foo"
        assert e.searched_dir == "/tmp"

    def test_BundleValidationError_is_ValueError(self):
        e = bundles.BundleValidationError("bad")
        assert isinstance(e, ValueError)
        assert str(e) == "bad"