// Generated from Microsoft HCU 697d3fbda04cb322915866bab1aad79c726a61e3 (MIT).
// See deploy/desktop/HCU-LICENSE. Regenerate with scripts/build-hcu.mjs.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
export const HCU_REVISION = "697d3fbda04cb322915866bab1aad79c726a61e3";
export const hcuDefinitions = {
  "AX": {
    "description": "Accessibility for application windows. Modes: apps lists confirmed windows (wN, title, app, active) and reports incomplete inventories; missing windows then remain unknown. observe returns the window tree with rN refs. find returns matching rN. act runs ordered steps, checks them before input, stops at the first failed step, and reports each target's change, windows opened/closed/focused, and a diff. Copy rN/wN exactly; stale refs fail. keypress/type without ref go to the focused window. select marks ref, its text substring, or ref..to_ref (paragraphs, cells) and reports the selection read back. activate/close take a title substring or wN. A wait step sends no input and fails the batch on timeout: window (title, any app), query (as find), ref with value/state/text, or text; gone inverts. settle needs no prediction: it waits until the UI changes after the step before it and stops changing; it fails only if nothing changed. After a window wait, keys go to that window, after settle to the focused one. Skip waits the report answers. Errors return code and hint. Examples:\n{\"mode\":\"act\",\"actions\":[{\"type\":\"click\",\"ref\":\"r12\"},{\"type\":\"wait\",\"window\":\"Export\"},{\"type\":\"type\",\"text\":\"q3.csv\"},{\"type\":\"keypress\",\"keys\":[\"ENTER\"]}]}\n{\"mode\":\"find\",\"window_ref\":\"w2\",\"query\":{\"role\":\"button\",\"name_contains\":\"Save\"}}",
    "parameters": {
      "$defs": {
        "query": {
          "additionalProperties": false,
          "description": "At least one filter; ANDed, case-insensitive.",
          "properties": {
            "name_contains": {
              "pattern": "\\S",
              "type": "string"
            },
            "name_equals": {
              "pattern": "\\S",
              "type": "string"
            },
            "role": {
              "pattern": "\\S",
              "type": "string"
            },
            "state": {
              "pattern": "\\S",
              "type": "string"
            },
            "text_contains": {
              "pattern": "\\S",
              "type": "string"
            },
            "text_equals": {
              "pattern": "\\S",
              "type": "string"
            }
          },
          "type": "object"
        }
      },
      "additionalProperties": false,
      "not": {
        "required": [
          "app",
          "window_ref"
        ]
      },
      "properties": {
        "actions": {
          "description": "act: ordered steps; a failed step stops the batch. Wait timeouts total at most 60000 ms; an omitted timeout counts as 5000 ms.",
          "items": {
            "additionalProperties": false,
            "properties": {
              "direction": {
                "enum": [
                  "up",
                  "down",
                  "left",
                  "right"
                ],
                "type": "string"
              },
              "gone": {
                "description": "wait until it is absent.",
                "type": "boolean"
              },
              "keys": {
                "description": "One chord, e.g. [\"CTRL\",\"S\"].",
                "items": {
                  "maxLength": 64,
                  "pattern": "^\\S(.*\\S)?$",
                  "type": "string"
                },
                "maxItems": 8,
                "minItems": 1,
                "type": "array"
              },
              "pages": {
                "exclusiveMinimum": 0,
                "maximum": 100,
                "type": "number"
              },
              "query": {
                "$ref": "#/$defs/query"
              },
              "ref": {
                "description": "rN element; wN for activate/close. Omit for keys/text to the focused window.",
                "pattern": "^[rw][1-9][0-9]*$",
                "type": "string"
              },
              "settle": {
                "description": "wait: true waits until the UI changes after the step before it, then stops changing.",
                "type": "boolean"
              },
              "state": {
                "description": "wait: ref state, e.g. checked.",
                "pattern": "\\S",
                "type": "string"
              },
              "text": {
                "description": "wait: text in the ref element, or anywhere in the window. select: substring of ref to select.",
                "maxLength": 10000,
                "minLength": 1,
                "type": "string"
              },
              "timeout_ms": {
                "description": "wait: default 5000.",
                "maximum": 60000,
                "minimum": 1,
                "type": "integer"
              },
              "title": {
                "description": "activate/close: unique window-title substring, instead of wN.",
                "pattern": "\\S",
                "type": "string"
              },
              "to_ref": {
                "description": "select: range end; ref..to_ref spans text or cells.",
                "pattern": "^r[1-9][0-9]*$",
                "type": "string"
              },
              "type": {
                "enum": [
                  "click",
                  "type",
                  "keypress",
                  "set_value",
                  "select",
                  "scroll",
                  "activate",
                  "close",
                  "wait"
                ],
                "type": "string"
              },
              "value": {
                "maxLength": 10000,
                "type": "string"
              },
              "window": {
                "description": "wait: a top-level window whose title contains this, on the whole desktop.",
                "pattern": "\\S",
                "type": "string"
              }
            },
            "required": [
              "type"
            ],
            "type": "object"
          },
          "maxItems": 64,
          "minItems": 1,
          "type": "array"
        },
        "app": {
          "description": "App name, app id, or PID; use once, then window_ref.",
          "pattern": "\\S",
          "type": "string"
        },
        "cursor": {
          "description": "find: next_cursor from a truncated result; send with mode find only.",
          "pattern": "^f[1-9][0-9]*$",
          "type": "string"
        },
        "limit": {
          "description": "find page size; default 20.",
          "maximum": 50,
          "minimum": 1,
          "type": "integer"
        },
        "mode": {
          "description": "apps lists confirmed top-level windows (wN, title, app, active) and reports incomplete inventories; observe returns a tree or diff with rN; find returns matching rN; act runs actions.",
          "enum": [
            "apps",
            "observe",
            "find",
            "act"
          ],
          "type": "string"
        },
        "observe": {
          "description": "Returned evidence. act: default diff; explicit tree returns the complete window tree, full adds the full-desktop GUI screenshot. observe: default tree. none only with act.",
          "enum": [
            "diff",
            "tree",
            "full",
            "screenshot",
            "none"
          ],
          "type": "string"
        },
        "query": {
          "$ref": "#/$defs/query"
        },
        "root": {
          "description": "observe: subtree at rN or the focused element.",
          "pattern": "^(focused|r[1-9][0-9]*)$",
          "type": "string"
        },
        "scope": {
          "description": "observe/find; default window.",
          "enum": [
            "window",
            "content"
          ],
          "type": "string"
        },
        "window_ref": {
          "description": "observe/find: window to read. act: omit when actions have refs, which name the window; it only sends ref-less keys/text to wN instead of the focused window.",
          "pattern": "^w[1-9][0-9]*$",
          "type": "string"
        }
      },
      "required": [
        "mode"
      ],
      "type": "object"
    }
  },
  "GUI": {
    "description": "Full-desktop screenshot and pixel input. {\"actions\":[{\"type\":\"screenshot\"}]} alone observes; {\"type\":\"zoom\",\"region\":[x0,y0,x1,y1]} alone enlarges a frame region to read small text and icons. Any other batch is checked before input and returns one final screenshot. x/y are pixels of the latest full-desktop image (screen width x height) from GUI or AX full/screenshot, which return the same frame. type/keypress go to the current focus, so click the field first. Batch the actions planned from one screenshot; end the batch after an action that may open, close, or move a window, and plan the rest from the returned image. GUI cannot address windows; AX activates and closes them by title. wait is one second with no observation, at most 20 s per batch. Errors return code and hint like AX; gui_frame_stale means nothing was sent: replan from the returned screenshot. Example: {\"actions\":[{\"type\":\"click\",\"x\":640,\"y\":412},{\"type\":\"type\",\"text\":\"hello\"},{\"type\":\"keypress\",\"keys\":[\"ENTER\"]}]}",
    "parameters": {
      "description": "One screenshot or zoom action observes; otherwise run an input batch.",
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "actions": {
              "items": {
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "type": {
                        "const": "screenshot",
                        "description": "Capture the final full desktop; this must be the only action.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "region": {
                        "description": "[x0,y0,x1,y1] frame pixels; sides >= 8.",
                        "items": {
                          "minimum": 0,
                          "type": "number"
                        },
                        "maxItems": 4,
                        "minItems": 4,
                        "type": "array"
                      },
                      "type": {
                        "const": "zoom",
                        "description": "Look only: enlarge a frame region; alone.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type",
                      "region"
                    ],
                    "type": "object"
                  }
                ]
              },
              "maxItems": 1,
              "minItems": 1,
              "type": "array"
            }
          },
          "required": [
            "actions"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "actions": {
              "description": "Ordered GUI actions.",
              "items": {
                "description": "One GUI action.",
                "oneOf": [
                  {
                    "additionalProperties": false,
                    "properties": {
                      "button": {
                        "description": "Mouse button. Defaults to left.",
                        "enum": [
                          "left",
                          "right",
                          "wheel",
                          "back",
                          "forward"
                        ],
                        "type": "string"
                      },
                      "keys": {
                        "description": "Held modifiers.",
                        "items": {
                          "enum": [
                            "CTRL",
                            "CONTROL",
                            "SHIFT",
                            "ALT",
                            "SUPER"
                          ],
                          "type": "string"
                        },
                        "maxItems": 8,
                        "type": "array"
                      },
                      "type": {
                        "const": "click",
                        "description": "Click.",
                        "type": "string"
                      },
                      "x": {
                        "description": "Screenshot X pixel.",
                        "type": "number"
                      },
                      "y": {
                        "description": "Screenshot Y pixel.",
                        "type": "number"
                      }
                    },
                    "required": [
                      "type",
                      "x",
                      "y"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "keys": {
                        "description": "Held modifiers.",
                        "items": {
                          "enum": [
                            "CTRL",
                            "CONTROL",
                            "SHIFT",
                            "ALT",
                            "SUPER"
                          ],
                          "type": "string"
                        },
                        "maxItems": 8,
                        "type": "array"
                      },
                      "type": {
                        "const": "double_click",
                        "description": "Double click.",
                        "type": "string"
                      },
                      "x": {
                        "description": "Screenshot X pixel.",
                        "type": "number"
                      },
                      "y": {
                        "description": "Screenshot Y pixel.",
                        "type": "number"
                      }
                    },
                    "required": [
                      "type",
                      "x",
                      "y"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "keys": {
                        "description": "Held modifiers.",
                        "items": {
                          "enum": [
                            "CTRL",
                            "CONTROL",
                            "SHIFT",
                            "ALT",
                            "SUPER"
                          ],
                          "type": "string"
                        },
                        "maxItems": 8,
                        "type": "array"
                      },
                      "type": {
                        "const": "move",
                        "description": "Move pointer.",
                        "type": "string"
                      },
                      "x": {
                        "description": "Screenshot X pixel.",
                        "type": "number"
                      },
                      "y": {
                        "description": "Screenshot Y pixel.",
                        "type": "number"
                      }
                    },
                    "required": [
                      "type",
                      "x",
                      "y"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "keys": {
                        "description": "Held modifiers.",
                        "items": {
                          "enum": [
                            "CTRL",
                            "CONTROL",
                            "SHIFT",
                            "ALT",
                            "SUPER"
                          ],
                          "type": "string"
                        },
                        "maxItems": 8,
                        "type": "array"
                      },
                      "path": {
                        "items": {
                          "additionalProperties": false,
                          "properties": {
                            "x": {
                              "description": "X pixel in the exact returned full-desktop image",
                              "type": "number"
                            },
                            "y": {
                              "description": "Y pixel in the exact returned full-desktop image",
                              "type": "number"
                            }
                          },
                          "required": [
                            "x",
                            "y"
                          ],
                          "type": "object"
                        },
                        "maxItems": 256,
                        "minItems": 2,
                        "type": "array"
                      },
                      "type": {
                        "const": "drag",
                        "description": "Drag path.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type",
                      "path"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "anyOf": [
                      {
                        "properties": {
                          "scroll_x": {
                            "not": {
                              "const": 0
                            }
                          }
                        },
                        "required": [
                          "scroll_x"
                        ]
                      },
                      {
                        "properties": {
                          "scroll_y": {
                            "not": {
                              "const": 0
                            }
                          }
                        },
                        "required": [
                          "scroll_y"
                        ]
                      }
                    ],
                    "properties": {
                      "keys": {
                        "description": "Held modifiers.",
                        "items": {
                          "enum": [
                            "CTRL",
                            "CONTROL",
                            "SHIFT",
                            "ALT",
                            "SUPER"
                          ],
                          "type": "string"
                        },
                        "maxItems": 8,
                        "type": "array"
                      },
                      "scroll_x": {
                        "maximum": 2000,
                        "minimum": -2000,
                        "type": "number"
                      },
                      "scroll_y": {
                        "maximum": 2000,
                        "minimum": -2000,
                        "type": "number"
                      },
                      "type": {
                        "const": "scroll",
                        "description": "Scroll at a point.",
                        "type": "string"
                      },
                      "x": {
                        "description": "Screenshot X pixel.",
                        "type": "number"
                      },
                      "y": {
                        "description": "Screenshot Y pixel.",
                        "type": "number"
                      }
                    },
                    "required": [
                      "type",
                      "x",
                      "y"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "text": {
                        "maxLength": 10000,
                        "type": "string"
                      },
                      "type": {
                        "const": "type",
                        "description": "Type literal text.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type",
                      "text"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "keys": {
                        "description": "PAGEUP/PAGE_UP/PAGEDOWN/PAGE_DOWN.",
                        "items": {
                          "maxLength": 64,
                          "pattern": "\\S",
                          "type": "string"
                        },
                        "maxItems": 8,
                        "minItems": 1,
                        "type": "array"
                      },
                      "type": {
                        "const": "keypress",
                        "description": "Press one key chord.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type",
                      "keys"
                    ],
                    "type": "object"
                  },
                  {
                    "additionalProperties": false,
                    "properties": {
                      "type": {
                        "const": "wait",
                        "description": "Wait exactly one second without an intermediate observation; do not stack waits.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "type"
                    ],
                    "type": "object"
                  }
                ]
              },
              "maxItems": 64,
              "minItems": 1,
              "type": "array"
            },
            "settle_ms": {
              "description": "Visual stillness: default 800ms, max 3000ms. Final screenshot stillness, not semantic success and not extra sleep. After wait, usually omit it. At the cap inspect the screenshot or use an AX wait step.",
              "maximum": 3000,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "actions"
          ],
          "type": "object"
        }
      ],
      "properties": {
        "actions": {},
        "settle_ms": {}
      },
      "type": "object"
    }
  }
} as unknown as Record<"AX" | "GUI", Pick<ToolDefinition, "description" | "parameters">>;
