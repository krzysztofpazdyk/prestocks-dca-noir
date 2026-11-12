/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `idl/predca.json`.
 */
export type Predca = {
  "address": "Eb3TFLeYi3dHZwoKCBvvUpx3gMnP2XdmMXX3rstUpdwC",
  "metadata": {
    "name": "predca",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "closePriceFeed",
      "docs": [
        "Close a PriceFeed. Signer is `config.authority`. Rent goes to `config.keeper`."
      ],
      "discriminator": [
        4,
        91,
        255,
        154,
        47,
        74,
        139,
        235
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "rentReceiver",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "priceFeed"
          ]
        },
        {
          "name": "priceFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeRunReceipts",
      "docs": [
        "Close legacy RunRecord / RunPrice accounts. Rent goes to `config.keeper`."
      ],
      "discriminator": [
        226,
        38,
        191,
        4,
        49,
        51,
        195,
        134
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "rentReceiver",
          "writable": true
        },
        {
          "name": "owner"
        },
        {
          "name": "userConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeUser",
      "docs": [
        "Close the USDC vault (must be empty) and UserConfig. Rent goes to the owner."
      ],
      "discriminator": [
        86,
        219,
        138,
        140,
        236,
        24,
        118,
        200
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "depositUsdc",
      "discriminator": [
        184,
        148,
        250,
        169,
        224,
        213,
        34,
        126
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeBuy",
      "docs": [
        "Keeper crank: owner is not a signer. Bot pays fees; vault PDA spends USDC.",
        "`skip_cooldown`: when true (enable force-buy), do not enforce 7-day last_run_ts cooldown."
      ],
      "discriminator": [
        14,
        137,
        248,
        5,
        172,
        244,
        183,
        152
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Global config: only config.keeper may crank execute_buy."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintA"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaB",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintB"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaC",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintC"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "runRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "runIndex"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "skipCooldown",
          "type": "bool"
        }
      ]
    },
    {
      "name": "executeBuyV2",
      "docs": [
        "Keeper crank of a priced buy. Same cooldown and last_run_ts rules as execute_buy."
      ],
      "discriminator": [
        75,
        39,
        221,
        15,
        224,
        141,
        61,
        134
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Global config: only config.keeper may crank execute_buy_v2."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintA"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaB",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintB"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaC",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintC"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "runRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "runIndex"
              }
            ]
          }
        },
        {
          "name": "priceFeedA"
        },
        {
          "name": "priceFeedB"
        },
        {
          "name": "priceFeedC"
        },
        {
          "name": "runPrice",
          "docs": [
            "space and seeds as `init`, payer = keeper) so this struct does not inline a second `init`."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "skipCooldown",
          "type": "bool"
        }
      ]
    },
    {
      "name": "executeBuyV3",
      "docs": [
        "Keeper crank of a priced buy. `fee_usdc` is the keeper's cost quote for this buy.",
        "The program caps it by `FeeConfig.max_fee_usdc` and `MAX_FEE_USDC`. Zero skips the transfer.",
        "When `FeeConfig.enabled` is false the buy still runs, but only with `fee_usdc == 0`.",
        "v2 is unchanged."
      ],
      "discriminator": [
        143,
        141,
        130,
        168,
        63,
        180,
        10,
        74
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Global config: only config.keeper may crank."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "feeConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feeUsdcAta",
          "docs": [
            "in `check_fee_ata` (same failures as the associated-token constraint plus mint)."
          ],
          "writable": true
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true
        },
        {
          "name": "ownerAtaB",
          "writable": true
        },
        {
          "name": "ownerAtaC",
          "writable": true
        },
        {
          "name": "runRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "runIndex"
              }
            ]
          }
        },
        {
          "name": "priceFeedA"
        },
        {
          "name": "priceFeedB"
        },
        {
          "name": "priceFeedC"
        },
        {
          "name": "runPrice",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "skipCooldown",
          "type": "bool"
        },
        {
          "name": "feeUsdc",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeBuyV4",
      "docs": [
        "Keeper crank of a priced buy. Writes the last-buy card. No RunRecord / RunPrice."
      ],
      "discriminator": [
        228,
        17,
        252,
        186,
        61,
        6,
        45,
        234
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Global config: only config.keeper may crank."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "feeConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feeUsdcAta",
          "docs": [
            "in `check_fee_ata` (same failures as the associated-token constraint plus mint)."
          ],
          "writable": true
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true
        },
        {
          "name": "ownerAtaB",
          "writable": true
        },
        {
          "name": "ownerAtaC",
          "writable": true
        },
        {
          "name": "priceFeedA"
        },
        {
          "name": "priceFeedB"
        },
        {
          "name": "priceFeedC"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "skipCooldown",
          "type": "bool"
        },
        {
          "name": "feeUsdc",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initFeeConfig",
      "docs": [
        "Create the single fee-config PDA. Signer must be `config.authority`."
      ],
      "discriminator": [
        212,
        138,
        200,
        114,
        73,
        176,
        7,
        197
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "maxFeeUsdc",
          "type": "u64"
        },
        {
          "name": "feeWallet",
          "type": "pubkey"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "keeper"
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeUser",
      "discriminator": [
        111,
        17,
        185,
        250,
        60,
        122,
        38,
        254
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "weeklyBudgetUsdc",
          "type": "u64"
        }
      ]
    },
    {
      "name": "migrateUser",
      "docs": [
        "Realloc a 59-byte UserConfig to 305 B and write the last-buy card.",
        "`payer` is the owner, `config.keeper`, or `config.authority`."
      ],
      "discriminator": [
        159,
        64,
        64,
        6,
        80,
        228,
        54,
        66
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner"
        },
        {
          "name": "userConfig",
          "docs": [
            "deserialize as the new UserConfig."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "lastRecord"
        },
        {
          "name": "lastRunPrice"
        },
        {
          "name": "nextRecord"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lastRunIndex",
          "type": {
            "option": "u64"
          }
        }
      ]
    },
    {
      "name": "recordRun",
      "discriminator": [
        203,
        171,
        212,
        47,
        170,
        30,
        0,
        146
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "runRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "runIndex"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "amounts",
          "type": {
            "array": [
              "u64",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setFeeConfig",
      "docs": [
        "Update the existing fee-config PDA. Signer must be `config.authority`."
      ],
      "discriminator": [
        221,
        222,
        52,
        206,
        114,
        198,
        64,
        91
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "maxFeeUsdc",
          "type": "u64"
        },
        {
          "name": "feeWallet",
          "type": "pubkey"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setKeeper",
      "discriminator": [
        102,
        94,
        23,
        78,
        157,
        222,
        243,
        214
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "keeper"
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "setPrice",
      "docs": [
        "Keeper or config authority sets the USD price for one stock mint."
      ],
      "discriminator": [
        16,
        19,
        182,
        8,
        149,
        83,
        72,
        181
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "priceFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "priceDecimals",
          "type": "u8"
        },
        {
          "name": "maxAgeSecs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setWeeklyBudget",
      "discriminator": [
        217,
        179,
        16,
        106,
        23,
        240,
        6,
        134
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "weeklyBudgetUsdc",
          "type": "u64"
        }
      ]
    },
    {
      "name": "simulateBuy",
      "discriminator": [
        114,
        119,
        83,
        45,
        3,
        11,
        107,
        77
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintA"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaB",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintB"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaC",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintC"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "runRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "runIndex"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "simulateBuyV2",
      "docs": [
        "Owner-signed buy. Mints floor(usdc/price) of each token. Does not touch last_run_ts."
      ],
      "discriminator": [
        89,
        30,
        168,
        24,
        97,
        40,
        67,
        118
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintA"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaB",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintB"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaC",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintC"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "runRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "runIndex"
              }
            ]
          }
        },
        {
          "name": "priceFeedA"
        },
        {
          "name": "priceFeedB"
        },
        {
          "name": "priceFeedC"
        },
        {
          "name": "runPrice",
          "docs": [
            "space and seeds as `init`) so this struct does not inline a second `init`."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "simulateBuyV3",
      "docs": [
        "Owner-signed priced buy. Writes the last-buy card. Does not touch last_run_ts."
      ],
      "discriminator": [
        162,
        19,
        185,
        19,
        37,
        139,
        142,
        119
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mintAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "mintA",
          "writable": true
        },
        {
          "name": "mintB",
          "writable": true
        },
        {
          "name": "mintC",
          "writable": true
        },
        {
          "name": "ownerAtaA",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintA"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaB",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintB"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerAtaC",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mintC"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "priceFeedA"
        },
        {
          "name": "priceFeedB"
        },
        {
          "name": "priceFeedC"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runIndex",
          "type": "u64"
        },
        {
          "name": "mints",
          "type": {
            "array": [
              "pubkey",
              3
            ]
          }
        },
        {
          "name": "signatureHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "withdrawUsdc",
      "discriminator": [
        114,
        49,
        72,
        184,
        27,
        156,
        243,
        155
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "userConfig"
          ]
        },
        {
          "name": "userConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "feeConfig",
      "discriminator": [
        143,
        52,
        146,
        187,
        219,
        123,
        76,
        155
      ]
    },
    {
      "name": "priceFeed",
      "discriminator": [
        189,
        103,
        252,
        23,
        152,
        35,
        243,
        156
      ]
    },
    {
      "name": "programConfig",
      "discriminator": [
        196,
        210,
        90,
        231,
        144,
        149,
        140,
        63
      ]
    },
    {
      "name": "runRecord",
      "discriminator": [
        150,
        11,
        254,
        208,
        250,
        147,
        105,
        152
      ]
    },
    {
      "name": "userConfig",
      "discriminator": [
        58,
        201,
        49,
        59,
        232,
        236,
        180,
        75
      ]
    }
  ],
  "events": [
    {
      "name": "buyV2Executed",
      "discriminator": [
        133,
        177,
        7,
        121,
        115,
        134,
        253,
        99
      ]
    },
    {
      "name": "buyV3Executed",
      "discriminator": [
        170,
        40,
        155,
        126,
        82,
        107,
        131,
        96
      ]
    },
    {
      "name": "buyV4Executed",
      "discriminator": [
        143,
        181,
        92,
        29,
        170,
        86,
        70,
        244
      ]
    },
    {
      "name": "priceUpdated",
      "discriminator": [
        154,
        72,
        87,
        150,
        246,
        230,
        23,
        217
      ]
    },
    {
      "name": "runRecorded",
      "discriminator": [
        47,
        240,
        241,
        169,
        100,
        47,
        145,
        102
      ]
    },
    {
      "name": "simulateBuyExecuted",
      "discriminator": [
        97,
        155,
        179,
        187,
        246,
        212,
        220,
        110
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6002,
      "name": "insufficientVault",
      "msg": "Insufficient vault balance"
    },
    {
      "code": 6003,
      "name": "invalidBudget",
      "msg": "Invalid weekly budget (must be > 0)"
    },
    {
      "code": 6004,
      "name": "runAlreadyExists",
      "msg": "RunRecord already exists"
    },
    {
      "code": 6005,
      "name": "invalidMintAuthority",
      "msg": "Invalid mint authority"
    },
    {
      "code": 6006,
      "name": "mintMismatch",
      "msg": "Mint mismatch"
    },
    {
      "code": 6007,
      "name": "duplicateMints",
      "msg": "Duplicate mints"
    },
    {
      "code": 6008,
      "name": "tooSoon",
      "msg": "Too soon: wait 7 days since last run"
    },
    {
      "code": 6009,
      "name": "priceMissing",
      "msg": "Price feed missing"
    },
    {
      "code": 6010,
      "name": "priceStale",
      "msg": "Price feed is stale"
    },
    {
      "code": 6011,
      "name": "invalidPrice",
      "msg": "Invalid price"
    },
    {
      "code": 6012,
      "name": "invalidPriceParams",
      "msg": "Invalid price parameters"
    },
    {
      "code": 6013,
      "name": "priceJumpTooLarge",
      "msg": "Price jump too large"
    },
    {
      "code": 6014,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6015,
      "name": "zeroTokenAmount",
      "msg": "Token amount rounded to zero"
    },
    {
      "code": 6016,
      "name": "feeTooHigh",
      "msg": "Fee exceeds MAX_FEE_USDC"
    },
    {
      "code": 6017,
      "name": "feeDisabled",
      "msg": "Fee config not enabled"
    },
    {
      "code": 6018,
      "name": "invalidFeeWallet",
      "msg": "Fee wallet is the default pubkey"
    },
    {
      "code": 6019,
      "name": "runIndexMismatch",
      "msg": "Run index does not follow the card"
    },
    {
      "code": 6020,
      "name": "userNotMigrated",
      "msg": "UserConfig has not been migrated"
    },
    {
      "code": 6021,
      "name": "alreadyMigrated",
      "msg": "UserConfig is already migrated"
    },
    {
      "code": 6022,
      "name": "instructionDeprecated",
      "msg": "Instruction is deprecated"
    },
    {
      "code": 6023,
      "name": "vaultNotEmpty",
      "msg": "Vault still holds tokens"
    },
    {
      "code": 6024,
      "name": "invalidReceipt",
      "msg": "Account is not a valid run receipt"
    },
    {
      "code": 6025,
      "name": "invalidRentReceiver",
      "msg": "Rent receiver must be the keeper"
    }
  ],
  "types": [
    {
      "name": "buyV2Executed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "runIndex",
            "type": "u64"
          },
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "amounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "prices",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "priceDecimals",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "usdcBurned",
            "type": "u64"
          },
          {
            "name": "signatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "buyV3Executed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "runIndex",
            "type": "u64"
          },
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "amounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "prices",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "priceDecimals",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "usdcBurned",
            "type": "u64"
          },
          {
            "name": "feeUsdc",
            "type": "u64"
          },
          {
            "name": "signatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "buyV4Executed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "runIndex",
            "type": "u64"
          },
          {
            "name": "origin",
            "type": "u8"
          },
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "amounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "prices",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "priceDecimals",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "priceTs",
            "type": {
              "array": [
                "i64",
                3
              ]
            }
          },
          {
            "name": "usdcEach",
            "type": "u64"
          },
          {
            "name": "usdcBurned",
            "type": "u64"
          },
          {
            "name": "feeUsdc",
            "type": "u64"
          },
          {
            "name": "signatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feeConfig",
      "docs": [
        "Global fee configuration PDA. Seeds = [b\"fee_config\"].",
        "One account. The per-buy amount is an argument of `execute_buy_v3`, not a stored constant.",
        "`max_fee_usdc` is the admin cap and must stay <= `MAX_FEE_USDC`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxFeeUsdc",
            "type": "u64"
          },
          {
            "name": "feeWallet",
            "type": "pubkey"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "priceFeed",
      "docs": [
        "USD price for one stock mint. PDA seeds = [b\"price\", mint].",
        "`price` is USD per one whole token, scaled by 10^price_decimals."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "priceDecimals",
            "type": "u8"
          },
          {
            "name": "updatedTs",
            "type": "i64"
          },
          {
            "name": "updatedSlot",
            "type": "u64"
          },
          {
            "name": "maxAgeSecs",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "priceUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "priceDecimals",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "signer",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "programConfig",
      "docs": [
        "Global program config PDA (seeds = [b\"config\"]).",
        "Stores the sole authorized keeper for execute_buy."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "runRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "amounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "signatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "runIndex",
            "type": "u64"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "runRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "runIndex",
            "type": "u64"
          },
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "amounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "signatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "simulateBuyExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "runIndex",
            "type": "u64"
          },
          {
            "name": "mints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "amounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "usdcBurned",
            "type": "u64"
          },
          {
            "name": "signatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "userConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "weeklyBudgetUsdc",
            "type": "u64"
          },
          {
            "name": "excludeFlags",
            "type": "u8"
          },
          {
            "name": "lastRunTs",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "cardVersion",
            "type": "u8"
          },
          {
            "name": "hasLastRun",
            "type": "bool"
          },
          {
            "name": "lastRunIndex",
            "type": "u64"
          },
          {
            "name": "lastBuyTs",
            "type": "i64"
          },
          {
            "name": "lastSlot",
            "type": "u64"
          },
          {
            "name": "lastMints",
            "type": {
              "array": [
                "pubkey",
                3
              ]
            }
          },
          {
            "name": "lastAmounts",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "lastPrices",
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "lastPriceDecimals",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "lastPriceTs",
            "type": {
              "array": [
                "i64",
                3
              ]
            }
          },
          {
            "name": "lastUsdcEach",
            "type": "u64"
          },
          {
            "name": "lastFeeUsdc",
            "type": "u64"
          },
          {
            "name": "lastSignatureHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lastOrigin",
            "type": "u8"
          }
        ]
      }
    }
  ]
}
