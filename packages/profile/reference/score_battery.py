"""Score a response sheet against battery.json and emit a DeveloperCognitiveProfile.

Usage:
    python score_battery.py battery.json responses.json > profile.json

responses.json: {"COG-01": "D", "DEBT-01": "B", ...}  (presented option labels)

Rules implemented (see battery.json -> profile_schema.aggregation):
  * Likert: value = likert_mapping.points[anchor]  (anchor letter A..E -> 1..5)
  * Choice: value = selected option's mapping[attribute]
  * Attribute estimate = mean of contributing values; topic weights and extended
    signals default to 0.5 when unobserved.
  * framing_strategy is derived from phi_framing; use_negative_politeness_tags is
    binarised at 0.5.
  * A coverage block reports how many items informed each estimate.
"""
import json
import sys
from collections import defaultdict
from statistics import mean

CORE = ["technical_debt_tolerance", "pedantry_level", "blocking_threshold", "kai_index",
        "regulatory_focus", "phi_framing", "directness_preference", "socratic_preference",
        "hedging_preference", "use_negative_politeness_tags"]
ANCHOR_TO_POINT = {"A": "1", "B": "2", "C": "3", "D": "4", "E": "5"}


def score(battery, responses):
    values = defaultdict(list)
    ext = defaultdict(list)
    answered, skipped = 0, []
    for item in battery["items"]:
        ans = responses.get(item["id"])
        if ans is None:
            skipped.append(item["id"])
            continue
        answered += 1
        if item["format"] == "likert_5":
            lm = item["likert_mapping"]
            values[lm["attribute"]].append(float(lm["points"][ANCHOR_TO_POINT[ans]]))
            continue
        opt = next(o for o in item["options"] if o["label"] == ans)
        for k, v in opt["mapping"].items():
            values[k].append(float(v))
        for k, v in (opt.get("extended_signals") or {}).items():
            ext[k].append(float(v))

    topics = battery["profile_schema"]["DeveloperCognitiveProfile"]["topic_weights"]["keys"]
    profile = {k: (round(mean(values[k]), 3) if values[k] else None) for k in CORE}
    profile["topic_weights"] = {t: round(mean(values[f"topic_weights.{t}"]), 3)
                                if values[f"topic_weights.{t}"] else 0.5 for t in topics}
    ext_keys = list(battery["profile_schema"]["ExtendedBehavioralSignals"])
    profile["extended_signals"] = {k: round(mean(ext[k]), 3) if ext[k] else 0.5 for k in ext_keys}

    phi = profile["phi_framing"]
    if phi is not None:
        profile["framing_strategy"] = ("Direct_Imperative" if phi < 0.33 else
                                       "Balanced_Inquisitive" if phi <= 0.66 else "Strictly_Socratic")
    tags = profile["use_negative_politeness_tags"]
    profile["use_negative_politeness_tags_bool"] = (tags is not None and tags >= 0.5)
    kai = profile["kai_index"]
    if kai is not None:
        profile["kai_classification"] = "Adaptor" if kai < 0.4 else "Bridger" if kai <= 0.6 else "Innovator"
    rf = profile["regulatory_focus"]
    if rf is not None:
        profile["regulatory_focus_label"] = "Prevention" if rf < 0.4 else "Mixed" if rf <= 0.6 else "Promotion"

    profile["coverage"] = {
        "items_answered": answered, "items_skipped": skipped,
        "n_per_attribute": {k: len(values[k]) for k in CORE},
        "n_per_topic": {t: len(values[f"topic_weights.{t}"]) for t in topics},
        "n_per_extended_signal": {k: len(ext[k]) for k in ext_keys},
    }
    profile["safety_floor"] = "Any defect candidate with sigma >= 0.80 is non-suppressible; Tier 3 must clamp S_effective >= sigma for it regardless of this profile."
    return profile


if __name__ == "__main__":
    battery = json.load(open(sys.argv[1]))
    responses = json.load(open(sys.argv[2]))
    json.dump(score(battery, responses), sys.stdout, indent=2)
