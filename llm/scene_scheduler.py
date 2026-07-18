from typing import Any, Dict


class _SceneSchedulerStub:
    def get_state(self) -> Dict[str, Any]:
        return {"enabled": False, "source": "stub"}


def get_scene_scheduler() -> _SceneSchedulerStub:
    return _SceneSchedulerStub()

