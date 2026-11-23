"""Offline contract checks against real AgentScope 2.0.12; no runtime adapter."""
import asyncio
import importlib.metadata
import json
import socket
from datetime import datetime
from pathlib import Path

from agentscope.agent import Agent, ModelConfig
from agentscope.credential import CredentialBase, OpenAICredential
from agentscope.formatter import OpenAIChatFormatter
from agentscope.message import Msg, TextBlock, ToolCallBlock, UserMsg
from agentscope.middleware import MiddlewareBase
from agentscope.model import ChatModelBase, ChatResponse, ChatUsage, OpenAIChatModel
from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.state import AgentState
from agentscope.tool import FunctionTool, Toolkit, ToolResponse
from openai.types.chat import ChatCompletion

VERSION = "2.0.12"
COMMIT = "28ab5ef6b1d8969c6ed8a3975c2063478a5c4986"
checks = {}


def deny_network(*args, **kwargs):
    raise AssertionError("Network access is forbidden in this offline probe")


class ControlledModel(ChatModelBase):
    """Deterministic fixture implementing the actual SDK extension point."""

    def __init__(self, *, retry=False, missing=False, cancelled=False):
        super().__init__(CredentialBase(), "controlled-fixture", self.Parameters(),
                         stream=False, max_retries=int(retry), retry_delay=0)
        self.calls = 0
        self.formatter = OpenAIChatFormatter()
        self.retry, self.missing, self.cancelled = retry, missing, cancelled

    @classmethod
    def _get_retryable_exceptions(cls):
        return (ConnectionError,)

    async def _call_api(self, model_name, messages, tools=None, tool_choice=None, **kwargs):
        self.calls += 1
        if self.cancelled:
            raise asyncio.CancelledError()
        if self.retry and self.calls == 1:
            raise ConnectionError("controlled first-attempt failure")
        return ChatResponse(content=[TextBlock(text="5")], is_last=True,
                            usage=None if self.missing else ChatUsage(
                                input_tokens=10, output_tokens=1, time=0))


class Observe(MiddlewareBase):
    def __init__(self):
        self.calls = 0
        self.usage_missing = []

    async def on_model_call(self, agent, input_kwargs, next_handler):
        self.calls += 1
        result = await next_handler()
        self.usage_missing.append(result.usage is None)
        return result


def make_agent(model, observer=None, state=None):
    return Agent(name="contract", system_prompt="Return the fixed fixture.",
                 model=model, state=state, middlewares=[observer] if observer else [],
                 model_config=ModelConfig(max_retries=0, fallback_model=None))


async def main():
    assert importlib.metadata.version("agentscope") == VERSION
    # Guard both direct sockets and asyncio's normal hostname resolution path.
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    socket.getaddrinfo = deny_network
    checks["sdk_version"] = VERSION

    msg = UserMsg(name="user", content="2 + 3", id="fixture-message")
    restored_msg = Msg.model_validate_json(msg.model_dump_json())
    assert restored_msg.id == msg.id and restored_msg.content[0].text == "2 + 3"
    checks["message_roundtrip"] = True

    def add(a: int, b: int) -> str:
        """Add two fixture integers."""
        return str(a + b)

    toolkit = Toolkit(tools=[FunctionTool(
        add, permission=PermissionDecision(PermissionBehavior.ALLOW, "pure fixture"))])
    schemas = await toolkit.get_tool_schemas()
    assert any(s["function"]["name"] == "add" for s in schemas)
    state = AgentState(session_id="contract-session", context=[msg])
    call = ToolCallBlock(id="fixture-call", name="add", input='{"a":2,"b":3}')
    call = ToolCallBlock.model_validate_json(call.model_dump_json())
    chunks = [item async for item in toolkit.call_tool(call, state)]
    result = chunks[-1]
    assert isinstance(result, ToolResponse) and result.id == call.id
    assert result.state == "success" and result.content[0].text == "5"
    checks["tool_schema_and_execution"] = {"name": "add", "result": "5", "call_id": result.id}

    restored = AgentState.model_validate_json(state.model_dump_json())
    assert restored.session_id == state.session_id and restored.context[0].id == msg.id
    response = await make_agent(ControlledModel(), state=restored).reply(UserMsg("user", "next"))
    assert response.content[0].text == "5"
    checks["state_roundtrip_and_reply"] = {"session_id": restored.session_id,
                                           "durable_runtime_recovery_tested": False}

    model, observer = ControlledModel(retry=True), Observe()
    reply = await make_agent(model, observer).reply(UserMsg("user", "retry fixture"))
    assert model.calls == 2 and observer.calls == 1 and reply.usage.input_tokens == 10
    checks["inner_retry_visibility"] = {"sdk_attempts": model.calls,
                                        "middleware_calls": observer.calls,
                                        "usage_is_synthetic": True}

    model, observer = ControlledModel(missing=True), Observe()
    events = [event async for event in make_agent(model, observer).reply_stream(UserMsg("user", "missing usage"))]
    end = [event for event in events if event.type == "MODEL_CALL_END"]
    assert len(end) == 1 and end[0].input_tokens == 0 and end[0].output_tokens == 0
    assert observer.usage_missing == [True]
    checks["missing_usage_event"] = {"response_usage_missing": True,
                                      "event_input_tokens": end[0].input_tokens,
                                      "event_output_tokens": end[0].output_tokens,
                                      "zero_is_not_settlement_proof": True}

    cancelled = await ControlledModel(cancelled=True)(messages=[msg])
    assert cancelled.finished_reason == "interrupted" and cancelled.usage is None
    checks["cancelled_model"] = {"finished_reason": str(cancelled.finished_reason), "usage_missing": True}

    # Exercise the real fixed-version parser; this fixture is not an API response capture.
    parser = OpenAIChatModel(credential=OpenAICredential(api_key="unused-offline-fixture"),
                             model="fixture", stream=False, max_retries=0,
                             client_kwargs={"max_retries": 0})
    completion = ChatCompletion.model_validate({
        "id": "fixture", "object": "chat.completion", "created": 0, "model": "fixture",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": "5"}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
                  "prompt_tokens_details": {"cached_tokens": 40}}})
    parsed = parser._parse_completion_response(datetime.now(), completion)
    await parser.client.close()
    assert (parsed.usage.input_tokens, parsed.usage.cache_input_tokens, parsed.usage.output_tokens) == (100, 40, 20)
    checks["cache_accounting"] = {"agentscope_input_inclusive": 100, "cache_read_subset": 40,
                                   "output": 20, "naive_sum_wrong": 160,
                                   "runtime_disjoint_input": 60, "correct_total": 120,
                                   "usage_is_synthetic": True}

    report = {"status": "passed", "agentscope_version": VERSION, "source_commit": COMMIT,
              "mode": "offline-real-sdk-controlled-fixtures", "network_forbidden": True,
              "production_adapter_delivered": False, "checks": checks}
    out = Path(__file__).with_name("result.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
