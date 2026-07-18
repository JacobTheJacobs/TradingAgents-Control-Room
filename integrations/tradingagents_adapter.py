"""
TradingAgents Decision Adapter - Phase 3 (TEXT PARSING VERSION)

Based on deep schema inspection results (2026-03-24):

CRITICAL FINDINGS:
- decision: str ("BUY") ← Top-level action
- final_trade_decision: str (12,455 chars!) ← Long text synthesis
- All analyst reports: str (3,000-18,000 chars each) ← Text with embedded proposals
- NO structured confidence, position_size, or risk fields found

ADAPTER STRATEGY:
1. Extract action from top-level decision string
2. Parse final_trade_decision text for key signals
3. Extract analyst proposals from their text reports
4. Calculate confidence from consensus
5. Use LLM to summarize thesis from long text
"""

import re
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger(__name__)


def _clean_text_block(text: Any, limit: Optional[int] = None) -> str:
    if not text:
        return ""
    value = str(text)
    value = re.sub(r"```[\s\S]*?```", " ", value)
    value = re.sub(r"<tool_call>[\s\S]*", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\{[^{}]{0,240}\}", " ", value)
    value = re.sub(r"^\s*\|.*$", " ", value, flags=re.MULTILINE)
    value = re.sub(r"[*_`>#|]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    if limit and len(value) > limit:
        return value[: limit - 3].rstrip() + "..."
    return value


def _extract_sentences(text: Any, max_sentences: int = 2, limit: int = 320) -> str:
    cleaned = _clean_text_block(text)
    if not cleaned:
        return ""
    sentences = re.findall(r"[^.!?]+[.!?]?", cleaned)
    if not sentences:
        return _clean_text_block(cleaned, limit)
    summary = " ".join(sentence.strip() for sentence in sentences[:max_sentences] if sentence.strip())
    return _clean_text_block(summary or cleaned, limit)


def parse_final_trade_decision(text: str) -> Dict[str, Any]:
    """
    Parse the final_trade_decision text (12,455 chars) to extract structured data.
    
    Expected patterns in text:
    - "FINAL TRANSACTION PROPOSAL: BUY" or similar
    - Confidence indicators: "high conviction", "moderate confidence", etc.
    - Position hints: "small position", "full allocation", etc.
    - Risk warnings: "risk factors include...", "concerns about..."
    
    Returns:
        Dict with extracted fields AND parser_quality metadata
    """
    
    if not text or not isinstance(text, str):
        return {
            "parser_quality": {
                "final_trade_decision_length": 0,
                "warnings": ["final_trade_decision is empty or not a string"]
            }
        }
    
    parsed = {
        "parser_quality": {
            "final_trade_decision_length": len(text),
            "warnings": []
        }
    }
    
    # ========================================================================
    # Extract Action
    # ========================================================================
    action_patterns = [
        r'FINAL RECOMMENDATION:\s*\**\s*(BUY|SELL|HOLD|LIQUIDATE|OVERWEIGHT|UNDERWEIGHT)\b',
        r'FINAL TRANSACTION PROPOSAL:\s*\*\*?(BUY|SELL|HOLD|OVERWEIGHT|UNDERWEIGHT)\*\*?',
        r"THE TRADER'?S FINAL ACTION:\s*\**\s*(BUY|SELL|HOLD|LIQUIDATE)\b",
        r'RECOMMENDATION:\s*(BUY|SELL|HOLD)',
        r'DECISION:\s*(BUY|SELL|HOLD)',
        r'ACTION:\s*(BUY|SELL|HOLD)',
        r'\bI\s+(?:go|choose)\s+\**(BUY|SELL|HOLD|LIQUIDATE)\b',
    ]
    
    for pattern in action_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            action = match.group(1).upper()
            # Normalize over/underweight to buy/sell
            if action == "OVERWEIGHT":
                action = "BUY"
            elif action == "UNDERWEIGHT":
                action = "SELL"
            parsed['action'] = action
            parsed['parser_quality']['action_source'] = 'regex_match'
            break
    else:
        # No pattern matched
        parsed['parser_quality']['warnings'].append("Action not found in text, using top-level decision")
    
    # ========================================================================
    # Extract Confidence (from text cues)
    # ========================================================================
    confidence_cues = {
        'high conviction': 0.9,
        'very confident': 0.85,
        'confident': 0.8,
        'moderate confidence': 0.65,
        'moderately confident': 0.65,
        'some confidence': 0.55,
        'low confidence': 0.4,
        'uncertain': 0.3,
        'highly uncertain': 0.2,
    }
    
    text_lower = text.lower()
    for cue, conf in confidence_cues.items():
        if cue in text_lower:
            parsed['confidence'] = conf
            parsed['parser_quality']['confidence_source'] = f'text_cue_{cue.replace(" ", "_")}'
            break

    if 'confidence' not in parsed:
        if "disciplined" in text_lower and "risk-aware" in text_lower:
            parsed['confidence'] = 0.72
            parsed['parser_quality']['confidence_source'] = 'text_cue_disciplined_risk_aware'
        elif "moderate" in text_lower and ("allocation" in text_lower or "position" in text_lower):
            parsed['confidence'] = 0.68
            parsed['parser_quality']['confidence_source'] = 'text_cue_moderate_position'
        elif "structural" in text_lower and "demand" in text_lower:
            parsed['confidence'] = 0.75
            parsed['parser_quality']['confidence_source'] = 'text_cue_structural_demand'
    
    # Default confidence if not found
    if 'confidence' not in parsed:
        parsed['parser_quality']['warnings'].append('No confidence cues found, using default')
        # Estimate from action strength
        if parsed.get('action') == 'BUY':
            parsed['confidence'] = 0.65  # Moderate default for buys
        elif parsed.get('action') == 'SELL':
            parsed['confidence'] = 0.60
        else:
            parsed['confidence'] = 0.50  # Hold = neutral
    
    # ========================================================================
    # Extract Thesis/Reasoning (first paragraph after proposal)
    # ========================================================================
    # Look for text after "FINAL TRANSACTION PROPOSAL"
    proposal_match = re.search(
        r'(?:FINAL RECOMMENDATION|FINAL TRANSACTION PROPOSAL|THE TRADER\'?S FINAL ACTION)[:\s\-\*]*[\s\S]{0,1800}',
        text,
        re.IGNORECASE,
    )
    if proposal_match:
        thesis_text = proposal_match.group(0)
        parsed['thesis'] = _extract_sentences(thesis_text, max_sentences=3, limit=420)
    else:
        parsed['thesis'] = _extract_sentences(text, max_sentences=3, limit=420)
    
    # ========================================================================
    # Extract Risk Notes (look for risk-related sections)
    # ========================================================================
    risk_patterns = [
        r'(?:RISK FACTORS|RISKS|CONCERNS|WARNING)[\s\S]{0,500}',
        r'risk(?: management)? assessment[:\s][\s\S]{0,500}',
    ]
    
    for pattern in risk_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            risk_text = match.group(0)
            risk_text = re.sub(r'\*\*+', '', risk_text)
            parsed['risk_notes'] = risk_text.strip()[:300] + "..." if len(risk_text) > 300 else risk_text.strip()
            break
    
    if 'risk_notes' not in parsed:
        # Default risk note
        parsed['risk_notes'] = "Standard market risks apply. See full analysis for details."
        parsed['parser_quality']['warnings'].append('No explicit risk sections found, using default')
    
    # ========================================================================
    # Extract Position Size Hints (if any)
    # ========================================================================
    position_patterns = [
        (r'(?:small|minor|minimal)\s+position', 0.02),
        (r'(?:moderate|medium)\s+position', 0.05),
        (r'(?:large|significant|substantial)\s+position', 0.10),
        (r'(?:full|maximum)\s+(?:allocation|position)', 0.20),
        (r'allocate\s+(\d+)%', None),  # Capture percentage
        (r'(\d+(?:\.\d+)?)%\s+(?:allocation|of\s+portfolio|of\s+the\s+portfolio|position)', None),
        (r'position\s+size[^0-9]{0,24}(\d+(?:\.\d+)?)%', None),
    ]
    
    for pattern, default_size in position_patterns:
        match = re.search(pattern, text_lower)
        if match:
            if default_size:
                parsed['position_size'] = default_size
                parsed['parser_quality']['position_size_source'] = f'text_hint_{pattern[:30]}'
            else:
                # Try to extract percentage
                try:
                    pct = float(match.group(1))
                    parsed['position_size'] = pct / 100.0
                    parsed['parser_quality']['position_size_source'] = 'percentage_direct'
                except:
                    parsed['parser_quality']['warnings'].append('Failed to parse percentage')
            break
    
    if 'position_size' not in parsed:
        parsed['parser_quality']['warnings'].append('No position hints found, using confidence-based default')
        # Default based on confidence
        conf = parsed.get('confidence', 0.5)
        if conf >= 0.8:
            parsed['position_size'] = 0.10
        elif conf >= 0.6:
            parsed['position_size'] = 0.05
        else:
            parsed['position_size'] = 0.02

    parsed['verdict_line'] = _extract_sentences(text, max_sentences=1, limit=220)

    return parsed


def adapt_decision(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert TradingAgents output to internal order schema.
    
    Based on actual schema from Phase 2 discovery:
    - decision: str ("BUY"/"SELL"/"HOLD")
    - state: dict with 13 keys including final_trade_decision (str)
    
    Args:
        result: Output from TradingAgentsService.analyze()
        
    Returns:
        Internal order proposal dict
    """
    
    if result.get("status") != "success":
        raise ValueError(
            f"Cannot adapt failed result: status={result.get('status')}, "
            f"error={result.get('error', 'Unknown')}"
        )
    
    state = result["state"]
    decision_str = result["decision"]  # "BUY" / "SELL" / "HOLD"
    
    # ========================================================================
    # CONFIRMED FIELDS (from state)
    # ========================================================================
    adapted = {
        # Core action (from top-level decision string)
        "action": decision_str,
        
        # Basic metadata
        "ticker": state.get("company_of_interest", "UNKNOWN"),
        "trade_date": state.get("trade_date", "UNKNOWN"),
        
        # Source tracking
        "source": "tradingagents",
        
        # Performance metrics
        "latency_ms": result.get("latency_ms", 0),
        "elapsed_seconds": result.get("elapsed_seconds", 0),
    }
    
    # ========================================================================
    # PARSE FINAL TRADE DECISION (12,455 char text)
    # ========================================================================
    final_decision_text = state.get("final_trade_decision", "")
    
    if final_decision_text and isinstance(final_decision_text, str):
        parsed = parse_final_trade_decision(final_decision_text)
        
        # Add parsed fields
        adapted["confidence"] = parsed.get("confidence", 0.5)
        adapted["thesis"] = parsed.get("thesis", "")
        adapted["position_size"] = parsed.get("position_size", 0.02)
        adapted["risk_notes"] = parsed.get("risk_notes", "")
        
        # CRITICAL: Add parser_quality metadata
        adapted["parser_quality"] = parsed.get("parser_quality", {})
        
        # Verify action matches
        if parsed.get("action") and parsed["action"] != decision_str:
            logger.warning(
                f"Action mismatch: top-level says {decision_str}, "
                f"final_trade_decision says {parsed['action']}"
            )
            adapted["parser_quality"]["warnings"].append(f"Action mismatch: {decision_str} vs {parsed['action']}")
    else:
        # Fallback defaults
        adapted["confidence"] = 0.5
        adapted["thesis"] = ""
        adapted["position_size"] = 0.02
        adapted["risk_notes"] = ""
        adapted["parser_quality"] = {
            "final_trade_decision_length": 0,
            "warnings": ["final_trade_decision is empty or not a string"]
        }
    
    # ========================================================================
    # EXTRACT ANALYST REPORTS (for UI display)
    # ========================================================================
    adapted["analyst_reports"] = {
        "fundamental": _truncate(state.get("fundamentals_report", ""), 500),
        "sentiment": _truncate(state.get("sentiment_report", ""), 500),
        "news": _truncate(state.get("news_report", ""), 500),
        "technical": _truncate(state.get("market_report", ""), 500),
    }
    
    # Extract analyst proposals from text
    adapted["analyst_consensus"] = _extract_analyst_consensus(state)
    
    # ========================================================================
    # DEBATE AND RISK TRANSCRIPTS (for audit trail)
    # ========================================================================
    adapted["debate_log"] = state.get("investment_debate_state", {})
    adapted["risk_review"] = state.get("risk_debate_state", {})
    
    # ========================================================================
    # RAW DATA REFERENCE
    # ========================================================================
    adapted["_raw_decision"] = decision_str
    adapted["_raw_state_keys"] = list(state.keys())
    adapted["_final_decision_length"] = len(final_decision_text) if final_decision_text else 0
    
    # Log summary
    logger.info(f"Adapted decision for {adapted['ticker']}: {adapted['action']}")
    logger.info(f"  Confidence: {adapted['confidence']:.2f}")
    logger.info(f"  Position size: {adapted['position_size']:.2%}")
    logger.info(f"  Final decision text: {adapted.get('_final_decision_length', 0)} chars")
    if "parser_quality" in adapted:
        n_warnings = len(adapted["parser_quality"].get("warnings", []))
        if n_warnings > 0:
            logger.warning(f"  Parser warnings: {n_warnings}")
    
    return adapted


def _extract_analyst_consensus(state: dict) -> Dict[str, str]:
    """
    Extract final proposals from each analyst report.
    """
    consensus = {}
    
    # Map report names to expected actions
    report_map = {
        "fundamentals_report": "fundamental",
        "sentiment_report": "sentiment",
        "news_report": "news",
        "market_report": "technical",
    }
    
    for report_key, analyst_name in report_map.items():
        report_text = state.get(report_key, "")
        if report_text and isinstance(report_text, str):
            # Look for proposal pattern
            match = re.search(
                r'FINAL TRANSACTION PROPOSAL:\s*\*\*?(BUY|SELL|HOLD|NEUTRAL)\*\*?',
                report_text,
                re.IGNORECASE
            )
            if match:
                proposal = match.group(1).upper()
                if proposal == "NEUTRAL":
                    proposal = "HOLD"
                consensus[analyst_name] = proposal
            else:
                consensus[analyst_name] = "UNKNOWN"
        else:
            consensus[analyst_name] = "MISSING"
    
    return consensus


def _truncate(text: str, max_length: int) -> str:
    """Truncate text to max_length with ellipsis."""
    if not text:
        return ""
    if len(text) <= max_length:
        return text
    return text[:max_length] + "..."


# Test function
if __name__ == "__main__":
    # Mock test with real structure
    test_result = {
        "ticker": "NVDA",
        "trade_date": "2026-03-24",
        "status": "success",
        "decision": "BUY",
        "state": {
            "company_of_interest": "NVDA",
            "trade_date": "2026-03-24",
            "final_trade_decision": """
FINAL TRANSACTION PROPOSAL: **BUY**

After careful consideration of the bull and bear arguments, we have high conviction in this recommendation.
NVDA shows strong fundamentals with quadrupled EPS since 2011. The company demonstrated resilience during
the 2020 pandemic and continues to lead in AI and GPU markets.

Risk factors include high valuation multiples and potential market correction. However, growth prospects
outweigh concerns. Recommend moderate position of 5% allocation.
""",
            "fundamentals_report": "FINAL TRANSACTION PROPOSAL: **BUY**\nStrong fundamentals...",
            "sentiment_report": "FINAL TRANSACTION PROPOSAL: Neutral\nMixed sentiment...",
            "news_report": "FINAL TRANSACTION PROPOSAL: **BUY**\nPositive news...",
            "market_report": "FINAL TRANSACTION PROPOSAL: **HOLD**\nTechnical signals mixed...",
            "investment_debate_state": {"judge_decision": "BUY", "count": 2},
            "risk_debate_state": {"judge_decision": "MODERATE RISK", "count": 1},
        },
        "elapsed_seconds": 180.5,
        "latency_ms": 180500
    }
    
    print("Testing enhanced adapter...")
    adapted = adapt_decision(test_result)
    
    print("\n" + "="*80)
    print("ADAPTED DECISION")
    print("="*80)
    for key, value in adapted.items():
        if isinstance(value, str) and len(value) > 100:
            print(f"{key}: {value[:100]}...")
        elif isinstance(value, dict):
            print(f"{key}: dict with {len(value)} keys")
        else:
            print(f"{key}: {value}")
    
    print("\n" + "="*80)
    print("ANALYST CONSENSUS")
    print("="*80)
    for analyst, proposal in adapted["analyst_consensus"].items():
        print(f"  {analyst}: {proposal}")
