---
row: update-record.scene.triggered
name: lands
fingerprint: 374e11090b2ece32
expect: lands
scenario: >
  the example scene read as a first accept, every paragraph new. The reading proposes two stated things and one implied thing, each citing a paragraph of the change, and all three are filed (A74-1).
because: "A74-12 review: when is accepted only as the page states it, and the rules say so; the relationship example no longer supplies one"
---
```json
[
  {"class": "stated", "subject": "new", "type": "place", "field": "name", "value": "The lamp room", "kind": "building", "evidence": ["¶3"], "note": "The room at the top of the tower where the light is tended."},
  {"class": "stated", "subject": "new", "type": "object", "field": "name", "value": "The shears", "evidence": ["¶3"], "note": "The shears that live on the lamp-room sill and are used for nothing but the wick."},
  {"class": "implied", "subject": "new", "type": "object", "field": "name", "value": "The clockwork", "evidence": ["p4"], "note": "The mechanism that turns the light and spends the weight Ines winds."}
]
```
