import sys
import os
sys.path.insert(0, r'c:\Users\kamaa\aether\brain')
from sslm_engine import _fallback, _gen

import asyncio

async def test():
    vibe = "html projem için geliştirme istedim ama sonuç bu şekilde"
    print("FALLBACK OUTPUT:")
    print("-" * 40)
    print(_fallback(vibe, "", "claude"))
    print("\n\nLLM SYSTEM PROMPT OUTPUT (Simulated Context):")
    print("-" * 40)
    # The actual _gen tests the LLM, let's just test get_enhanced_system_prompt
    from prompt_knowledge_base import get_enhanced_system_prompt, get_relevant_patterns, build_pattern_context
    patterns = get_relevant_patterns(vibe)
    pattern_ctx = build_pattern_context(patterns)
    print(f"Matched Patterns Context: {pattern_ctx}")
    sys_prompt = get_enhanced_system_prompt(category_hint=vibe, family="claude")
    print("\nSystem Prompt:")
    print(sys_prompt)

asyncio.run(test())
