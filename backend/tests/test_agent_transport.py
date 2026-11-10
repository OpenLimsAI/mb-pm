"""Exercise the CLI and MCP wire contract without credentials or network access."""

import io
import json
import os
import runpy
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "maibo-agent.py"
agent = runpy.run_path(str(SCRIPT))
TOKEN = "test.token.never-log"


class AgentTransportTest(unittest.TestCase):
    def test_mcp_handshake_discovery_and_query(self):
        commands = [
            {"id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
            {"method": "notifications/initialized"},
            {"id": 2, "method": "tools/list"},
            {
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "tasks",
                    "arguments": {"project_id": "A&B", "overdue": True, "page_size": 2},
                },
            },
        ]
        incoming = io.BytesIO(
            "".join(json.dumps({"jsonrpc": "2.0", **cmd}) + "\n" for cmd in commands).encode()
        )
        outgoing = io.BytesIO()
        http, connection, response = self.connection()
        response.read.return_value = '{"items":[{"name":"逾期任务"}],"total":1}'.encode()
        with http:
            client = agent["Client"]("https://maibo.example", TOKEN)
            agent["serve_mcp"](client, incoming, outgoing)

        handshake, catalogue, answer = map(json.loads, outgoing.getvalue().splitlines())
        self.assertEqual(handshake["result"]["protocolVersion"], "2025-11-25")
        tools = {tool["name"]: tool for tool in catalogue["result"]["tools"]}
        self.assertTrue(
            {
                "projects",
                "tasks",
                "task",
                "baseline",
                "risk_report",
                "project_context",
                "register",
                "schedule_preview",
                "propose",
                "proposals",
                "proposal",
                "cancel_proposal",
                "retry_proposal",
                "knowledge_search",
                "knowledge_read",
                "changes",
                "start_analysis",
                "analysis_jobs",
                "analysis_job",
                "analysis_result",
                "cancel_analysis",
                "retry_analysis",
            }
            <= tools.keys()
        )
        self.assertTrue(tools["schedule_preview"]["annotations"]["readOnlyHint"])
        self.assertFalse(tools["propose"]["annotations"]["readOnlyHint"])
        self.assertEqual(answer["result"]["structuredContent"]["items"], [{"name": "逾期任务"}])
        connection.request.assert_called_once_with(
            "GET",
            "/api/v1/agent/tasks?project_id=A%26B&overdue=true&page_size=2",
            headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
        )

    def test_cli_rejects_non_loopback_http_without_printing_token(self):
        env = {
            **os.environ,
            "MAIBO_AGENT_BASE_URL": "http://maibo.example",
            "MAIBO_AGENT_TOKEN": TOKEN,
        }
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "projects"], env=env, capture_output=True, timeout=5
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "configuration_error")
        self.assertNotIn(TOKEN.encode(), result.stderr)

    def test_mutating_tool_submits_only_a_typed_draft_and_stable_request_id(self):
        http, connection, response = self.connection(201)
        response.read.return_value = b'{"id":"proposal-1","state":"pending_confirmation"}'
        body = {
            "request_id": "proposal-repeat-key",
            "reason": "实验延期",
            "action": {
                "kind": "update_progress",
                "task_id": "t1",
                "expected_revision": 2,
                "progress": 40,
            },
        }
        with http:
            client = agent["Client"]("https://maibo.example", TOKEN)
            tool = agent["TOOLS"]["propose"]
            with self.assertRaises(agent["AgentError"]):
                client.call(
                    tool,
                    {"project_id": "p1", **body, "action": {**body["action"], "approve": True}},
                )
            connection.request.assert_not_called()
            self.assertEqual(
                client.call(tool, {"project_id": "p1", **body})["state"], "pending_confirmation"
            )
        self.assertEqual(
            connection.request.call_args.args, ("POST", "/api/v1/agent/projects/p1/proposals")
        )
        self.assertEqual(json.loads(connection.request.call_args.kwargs["body"]), body)

    def test_token_is_not_forwarded_on_redirect_or_path_injection(self):
        http, connection, response = self.connection(302)
        with http:
            client = agent["Client"]("https://maibo.example", TOKEN)
            with self.assertRaises(agent["AgentError"]) as invalid:
                client.call(agent["TOOLS"]["task"], {"task_id": "../../projects"})
            self.assertEqual(invalid.exception.code, "invalid_arguments")
            connection.request.assert_not_called()

            with self.assertRaises(agent["AgentError"]) as redirect:
                client.call(agent["TOOLS"]["risk-report"], {"project_id": "prj-2026.1"})
            self.assertEqual(redirect.exception.code, "unexpected_redirect")
            connection.request.assert_called_once_with(
                "GET",
                "/api/v1/agent/projects/prj-2026.1/risk-report",
                headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
            )

    def test_model_job_requires_explicit_consent_and_embeds_both_ids_safely(self):
        tools = agent["TOOLS"]
        with self.assertRaises(agent["AgentError"]):
            tools["start-analysis"].endpoint(
                {"project_id": "p", "request_id": "r", "allow_model_processing": False}
            )
        endpoint = tools["analysis-result"].endpoint({"project_id": "P&1", "job_id": "job-2"})
        self.assertEqual(endpoint, "/api/v1/agent/projects/P%261/analysis-jobs/job-2/result")
        with self.assertRaises(agent["AgentError"]):
            tools["analysis-result"].endpoint({"project_id": "p", "job_id": ".."})

    @staticmethod
    def connection(status=200):
        connection = MagicMock()
        response = connection.getresponse.return_value.__enter__.return_value
        response.status = status
        response.headers.get_content_type.return_value = "application/json"
        return patch("http.client.HTTPSConnection", return_value=connection), connection, response


if __name__ == "__main__":
    unittest.main()
