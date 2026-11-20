"""Silero VAD v6: a speech probability for every 32 ms of 16 kHz audio."""
import numpy as np
import onnxruntime as ort

FRAME = 512  # samples per decision at 16 kHz (32 ms)
_CONTEXT = 64  # samples of the previous frame the model sees in front of each frame


class SileroModel:
    """One ONNX session, shared. Each stream keeps its own recurrent state (SileroState)."""

    def __init__(self, path: str):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(16000, dtype=np.int64)

    def new_state(self) -> "SileroState":
        return SileroState(self)


class SileroState:
    def __init__(self, model: SileroModel):
        self.model = model
        self.state = np.zeros((2, 1, 128), np.float32)
        self.context = np.zeros((1, _CONTEXT), np.float32)

    def prob(self, frame: np.ndarray) -> float:
        """Speech probability of one FRAME-sample frame."""
        x = np.concatenate([self.context, frame.reshape(1, FRAME).astype(np.float32, copy=False)], axis=1)
        out, self.state = self.model.session.run(None, {"input": x, "state": self.state, "sr": self.model._sr})
        self.context = x[:, -_CONTEXT:]
        return float(out[0, 0])
