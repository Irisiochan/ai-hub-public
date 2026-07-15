import importlib.util
import os
import shutil
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


with tempfile.TemporaryDirectory(prefix="ai-hub-vault-smoke-") as temp:
    vault = Path(temp) / "vault"
    shutil.copytree(ROOT / "template", vault)

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

    context = server.get_context()
    assert "核心记忆" in context

print("memory-vault smoke: ok")
