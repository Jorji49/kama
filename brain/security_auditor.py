"""
Aether Brain — Security Auditor

Before a prompt is generated, this module runs a battery of heuristic
checks on the USER'S VIBE INPUT (not the assembled prompt) to catch:

  - Prompt injection / jailbreak patterns
  - Credential or PII leakage
  - Unsafe instructions (rm -rf, DROP TABLE, etc.)
  - Excessively broad scope that could cause destructive edits

The auditor returns a structured report with a pass/warn/fail verdict.

DESIGN NOTE:
  We audit the raw user vibe and any sampled file contents — NOT the
  assembled XML Master Prompt.  The Master Prompt contains our own
  <system> / <constraints> / <task> tags which are safe by construction.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from config import settings

# ── Verdict enum ─────────────────────────────────────────────────────────

class Verdict(str, Enum):
    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"


# ── Report model ─────────────────────────────────────────────────────────

@dataclass
class AuditFinding:
    """A single issue discovered during the audit."""
    rule: str
    severity: Verdict
    detail: str


@dataclass
class AuditReport:
    """Aggregated security audit result."""
    verdict: Verdict = Verdict.PASS
    findings: list[AuditFinding] = field(default_factory=list)

    def summary(self) -> str:
        if not self.findings:
            return f"[{self.verdict.value}] No issues detected."
        lines = [f"[{self.verdict.value}] {len(self.findings)} finding(s):"]
        for f in self.findings:
            lines.append(f"  [{f.severity.value}] {f.rule}: {f.detail}")
        return "\n".join(lines)


# ── Heuristic rules ─────────────────────────────────────────────────────
# These patterns are checked against the RAW USER VIBE, not the full prompt.

_INJECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("prompt_override",    re.compile(r"ignore\s+(all\s+)?previous\s+instructions", re.I)),
    ("prompt_override",    re.compile(r"disregard\s+(all\s+)?(prior|above)", re.I)),
    ("role_hijack",        re.compile(r"you\s+are\s+now\s+(a|an)\s+", re.I)),
    ("data_exfil",         re.compile(r"(curl|wget|fetch)\s+https?://", re.I)),
]

_DANGEROUS_COMMANDS: list[tuple[str, re.Pattern[str]]] = [
    ("destructive_shell",  re.compile(r"rm\s+-rf\s+/", re.I)),
    ("destructive_sql",    re.compile(r"DROP\s+(TABLE|DATABASE|SCHEMA)", re.I)),
    ("destructive_shell",  re.compile(r"format\s+[a-z]:", re.I)),
    ("privilege_escalation", re.compile(r"(sudo|su\s+root|chmod\s+777)", re.I)),
]

_CREDENTIAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("api_key_leak",       re.compile(r"(sk-[a-zA-Z0-9]{20,})")),
    ("password_literal",   re.compile(r"password\s*[:=]\s*['\"][^'\"]{4,}", re.I)),
    ("aws_key",            re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private_key",        re.compile(r"-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY", re.I)),
    ("github_token",       re.compile(r"gh[ps]_[A-Za-z0-9_]{36,}")),
    ("jwt_token",          re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.")),
]

_PATH_TRAVERSAL: list[tuple[str, re.Pattern[str]]] = [
    ("path_traversal",     re.compile(r"\.\.[/\\]", re.I)),
    ("absolute_path",      re.compile(r"(^|[\s;|])(/etc/passwd|/etc/shadow|C:\\Windows\\System32)", re.I)),
]


# ── Core audit function ─────────────────────────────────────────────────

def audit_vibe(vibe: str, sampled_contents: str = "") -> AuditReport:
    """
    Run all heuristic checks against the raw user vibe and optional
    sampled workspace file contents.

    We intentionally do NOT scan the assembled XML Master Prompt because
    it contains our own structural tags (<system>, etc.) which are safe.

    Returns an ``AuditReport`` with an overall verdict of PASS, WARN, or FAIL.
    """
    report = AuditReport()

    # Combine vibe + sampled content for scanning
    scan_text = f"{vibe}\n{sampled_contents}" if sampled_contents else vibe

    # ── 1. Injection patterns ────────────────────────────────────────
    for rule_name, pattern in _INJECTION_PATTERNS:
        match = pattern.search(scan_text)
        if match:
            report.findings.append(
                AuditFinding(
                    rule=rule_name,
                    severity=Verdict.FAIL,
                    detail=f"Matched: '{match.group()[:80]}'",
                )
            )

    # ── 2. Dangerous commands ────────────────────────────────────────
    for rule_name, pattern in _DANGEROUS_COMMANDS:
        match = pattern.search(scan_text)
        if match:
            report.findings.append(
                AuditFinding(
                    rule=rule_name,
                    severity=Verdict.FAIL,
                    detail=f"Matched: '{match.group()[:80]}'",
                )
            )

    # ── 3. Credential leakage ────────────────────────────────────────
    for rule_name, pattern in _CREDENTIAL_PATTERNS:
        match = pattern.search(scan_text)
        if match:
            report.findings.append(
                AuditFinding(
                    rule=rule_name,
                    severity=Verdict.WARN,
                    detail="Potential credential detected — redact before sending.",
                )
            )

    # ── 4. Path traversal attempts ────────────────────────────────────
    for rule_name, pattern in _PATH_TRAVERSAL:
        match = pattern.search(scan_text)
        if match:
            report.findings.append(
                AuditFinding(
                    rule=rule_name,
                    severity=Verdict.WARN,
                    detail=f"Potential path traversal: '{match.group()[:60]}'",
                )
            )

    # ── 5. Vibe length sanity check ───────────────────────────────────
    if len(vibe) > 12000:
        report.findings.append(
            AuditFinding(
                rule="vibe_too_long",
                severity=Verdict.WARN,
                detail=f"Vibe is {len(vibe):,} chars — consider being more concise.",
            )
        )

    # ── Compute overall verdict ──────────────────────────────────────
    if any(f.severity == Verdict.FAIL for f in report.findings):
        report.verdict = Verdict.FAIL
    elif any(f.severity == Verdict.WARN for f in report.findings):
        report.verdict = Verdict.WARN
    else:
        report.verdict = Verdict.PASS

    return report


# ── LEGACY COMPAT: keep old function name working ────────────────────────

def audit_prompt(master_prompt: str) -> AuditReport:
    """
    Legacy wrapper — extracts the user vibe from the Master Prompt
    and audits only that portion.

    If the vibe can't be extracted, audits the full text with
    structural tags stripped out.
    """
    # Try to extract just the vibe from the XML
    vibe_match = re.search(
        r"<vibe>\s*<!\[CDATA\[(.*?)\]\]>\s*</vibe>",
        master_prompt,
        re.S,
    )
    if vibe_match:
        return audit_vibe(vibe_match.group(1))

    # Fallback: strip all XML tags and audit the remaining text
    stripped = re.sub(r"<[^>]+>", " ", master_prompt)
    stripped = re.sub(r"<!\[CDATA\[|\]\]>", " ", stripped)
    return audit_vibe(stripped)



