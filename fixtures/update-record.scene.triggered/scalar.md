---
row: update-record.scene.triggered
name: scalar
fingerprint: d61302cd873e420e
expect: lands
scenario: >
  an accept that gives Ines a sore shoulder. The reading proposes a condition and a location for a person the record holds; a field of her own record has no record of its own, so both are dropped as changes to an existing record and counted (A74-12).
because: "A74-12 review: when is accepted only as the page states it, and the rules say so; the relationship example no longer supplies one"
---
```json
[
  {"class": "stated", "subject": "char.ines", "type": "character", "field": "condition", "value": "a sore shoulder from the crank", "evidence": ["¶4"]},
  {"class": "implied", "subject": "char.ines", "type": "character", "field": "location", "value": "place.whitcombe-light", "evidence": ["¶4"]}
]
```
