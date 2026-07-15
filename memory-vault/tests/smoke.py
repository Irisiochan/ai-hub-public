import importlib.util
import os
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


with tempfile.TemporaryDirectory(prefix="ai-hub-vault-smoke-") as temp:
    vault = Path(temp) / "vault"

    os.environ["MEMORY_VAULT_PATH"] = str(vault)
    os.environ["VAULT_GIT_SYNC"] = "auto"

    spec = importlib.util.spec_from_file_location(
        "memory_vault_smoke_server", ROOT / "_meta" / "mcp_server.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load memory-vault server")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)

    assert server.VAULT == vault.resolve()
    assert server.DEFAULT_VAULT == (ROOT.parent / "vault-data").resolve()
    assert (vault / "_meta" / "vault_config.yaml").exists()
    assert (vault / "memories" / "owner-core.md").exists()
    assert not server._git_enabled(), "a parent source repo must never enable vault git sync"

    result = server.write_inbox(
        slug="smoke-note",
        title="Smoke note",
        content="The bundled vault stores private data outside the source tree.",
        tags=["smoke"],
        source="smoke-test",
    )
    notes = list((vault / "inbox").glob("*_smoke-note.md"))
    assert len(notes) == 1
    assert "已保存到本地 vault" in result

    promoted = server.promote_to_memory(notes[0].name)
    assert "已升级" in promoted
    assert (vault / "memories" / notes[0].name).exists()
    assert not notes[0].exists()

    context = server.get_context()
    assert "核心记忆" in context

    outside = vault.parent / "escape-proof.md"
    rejected = [
        server.write_memory("../../escape-proof", "x", "x", []),
        server.write_inbox("../../escape-proof", "x", "x", []),
        server.write_diary("../../escape-proof", "x", "x"),
        server.add_task("../../escape-proof", "x", ""),
        server.promote_to_memory("../../escape-proof.md"),
    ]
    assert all("不合法" in result for result in rejected)
    assert not outside.exists(), "path traversal escaped the vault"

    for invalid in [".hidden", "has.dot", "slash/name", r"back\slash", "a" * 82]:
        assert "不合法" in server.write_memory(invalid, "x", "x", [])

print("memory-vault smoke: ok")
