import path from "node:path";

import express from "express";

import type { ApprovalBroker } from "./approval-broker.js";
import { tokensEqual } from "./auth.js";
import type { AppConfig } from "./config.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8ecf5; }
    main { width: min(620px, calc(100vw - 40px)); padding: 28px; border: 1px solid #2a3550; border-radius: 16px; background: #121a2d; }
    code { overflow-wrap: anywhere; color: #bad0ff; }
    .warning { padding: 12px; border-radius: 10px; background: #3c2316; color: #ffd8bd; }
    .ok { color: #9de8af; }
    .error { color: #ff9f9f; }
    label { display: block; margin: 14px 0 6px; font-weight: 650; }
    input, select { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #52617d; border-radius: 9px; background: #0b1020; color: white; }
    .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
    button { padding: 12px; border: 0; border-radius: 9px; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .approve { background: #2f7d46; } .deny { background: #9a3d3d; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
}

function requestSummary(broker: ApprovalBroker, requestId: string): string | undefined {
  const pending = broker.getPending(requestId);
  if (!pending) {
    return undefined;
  }
  const req = pending.request;
  return `
    <p><strong>프로젝트:</strong> <code>${escapeHtml(req.projectId)}</code></p>
    <p><strong>Capability:</strong> <code>${escapeHtml(req.capability)}</code></p>
    <p><strong>OAuth client:</strong> <code>${escapeHtml(req.subjectId)}</code></p>
    ${req.providerLabel ? `<p><strong>표시 provider:</strong> <code>${escapeHtml(req.providerLabel)}</code></p>` : ""}
    ${req.path ? `<p><strong>경로:</strong> <code>${escapeHtml(req.path)}</code></p>` : ""}
    ${req.command ? `<p><strong>명령:</strong> <code>${escapeHtml(path.basename(req.command.executable))} ${escapeHtml((req.command.args ?? []).join(" "))}</code></p>` : ""}
    ${req.networkTarget ? `<p><strong>네트워크:</strong> <code>${escapeHtml(req.networkTarget)}</code></p>` : ""}
    ${req.reason ? `<p><strong>요청 사유:</strong> ${escapeHtml(req.reason)}</p>` : ""}
    <p><strong>상태:</strong> ${escapeHtml(pending.status)}</p>
  `;
}

export function registerApprovalRoutes(
  app: express.Express,
  config: AppConfig,
  broker: ApprovalBroker,
): void {
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  app.get("/approvals/:requestId", (request, response) => {
    const requestId = request.params.requestId;
    const summary = requestSummary(broker, requestId);
    if (!summary) {
      response.status(404).type("html").send(page("승인 요청 없음", "<p class=\"error\">요청을 찾을 수 없습니다.</p>"));
      return;
    }
    const pending = broker.getPending(requestId)!;
    if (pending.status !== "pending") {
      response.type("html").send(page("coka capability 승인", `${summary}<p class="ok">이 요청은 이미 처리되었습니다.</p>`));
      return;
    }
    response
      .set({
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      })
      .type("html")
      .send(page("coka capability 승인", `
        ${summary}
        <p class="warning">이 승인은 표시된 capability에만 적용됩니다. HARD_DENY 항목은 승인할 수 없습니다.</p>
        ${pending.request.command ? '<p class="warning">실행 승인은 표시된 정확한 argv의 프로세스 시작을 허용합니다. 승인된 자식 프로세스 자체를 커널 수준으로 샌드박스하는 승인은 아니므로, 격리된 실행 환경 안에서만 승인하세요.</p>' : ""}
        <form method="post" autocomplete="off">
          <label for="access_key">운영자 인증키</label>
          <input id="access_key" name="access_key" type="password" required autocomplete="current-password">
          <label for="ttl">유효시간</label>
          <select id="ttl" name="ttl"><option value="300000">5분</option><option value="1800000" selected>30분</option><option value="3600000">60분</option></select>
          <label for="max_uses">최대 사용 횟수</label>
          <select id="max_uses" name="max_uses"><option value="1">1회</option><option value="10" selected>10회</option><option value="20">20회</option></select>
          <div class="buttons">
            <button class="approve" name="decision" value="approve" type="submit">승인</button>
            <button class="deny" name="decision" value="deny" type="submit">거부</button>
          </div>
        </form>
      `));
  });

  app.post("/approvals/:requestId", form, (request, response) => {
    if (!config.oauthApprovalKey) {
      response.status(503).type("html").send(page("승인 비활성", "<p class=\"error\">운영자 승인키가 구성되지 않았습니다.</p>"));
      return;
    }

    const requestId = request.params.requestId;
    const pending = broker.getPending(requestId);
    if (!pending) {
      response.status(404).type("html").send(page("승인 요청 없음", "<p class=\"error\">요청을 찾을 수 없습니다.</p>"));
      return;
    }

    const accessKey = typeof request.body?.access_key === "string" ? request.body.access_key : "";
    if (!accessKey || !tokensEqual(accessKey, config.oauthApprovalKey)) {
      response.status(401).type("html").send(page("승인 실패", "<p class=\"error\">운영자 인증키가 올바르지 않습니다.</p>"));
      return;
    }

    if (request.body?.decision === "deny") {
      broker.denyFromTrustedChannel(requestId);
      console.log(JSON.stringify({
        event: "capability_approval",
        requestId,
        subjectId: pending.request.subjectId,
        projectId: pending.request.projectId,
        capability: pending.request.capability,
        decision: "denied",
        at: new Date().toISOString(),
      }));
      response.type("html").send(page("요청 거부", "<p>Capability 요청을 거부했습니다.</p>"));
      return;
    }

    const ttlMs = Number(request.body?.ttl);
    const maxUses = Number(request.body?.max_uses);
    const req = pending.request;
    const grant = broker.approveFromTrustedChannel(requestId, {
      approvedBy: "operator",
      approvalChannel: "local-ui",
      subjectId: req.subjectId,
      providerLabel: req.providerLabel,
      projectId: req.projectId,
      capabilities: [req.capability],
      paths: req.path ? [req.path] : undefined,
      commands: req.command ? [path.basename(req.command.executable)] : undefined,
      commandSpecs: req.command
        ? [{ executable: path.basename(req.command.executable), args: [...(req.command.args ?? [])] }]
        : undefined,
      networkTargets: req.networkTarget ? [req.networkTarget] : undefined,
      ttlMs: Number.isFinite(ttlMs) ? ttlMs : 30 * 60_000,
      maxUses: Number.isFinite(maxUses) ? maxUses : 10,
    });

    console.log(JSON.stringify({
      event: "capability_approval",
      requestId,
      grantId: grant.grantId,
      subjectId: grant.subjectId,
      projectId: grant.projectId,
      capability: req.capability,
      decision: "approved",
      expiresAt: grant.expiresAt,
      maxUses: grant.maxUses,
      at: new Date().toISOString(),
    }));

    response.type("html").send(page(
      "승인 완료",
      `<p class="ok">승인되었습니다.</p><p>Grant: <code>${escapeHtml(grant.grantId)}</code></p><p>만료: ${new Date(grant.expiresAt).toISOString()}</p><p>최대 사용: ${grant.maxUses}</p>`,
    ));
  });
}
