// Seção `recovery` do contrato (Recovery -> CRM: recovery.opted_out.v1; eventos INTERNOS non_buyer.* do CRM). DONO: tgr-commercial-suite (seção `recovery`,
// fixture apps/sales-command/server/test/fixtures/crm-recovery-events.snapshot.json, main ea2b6ce6); o CRM publica a seção idêntica à fixture (sem `_source`).
// SOMENTE CONTRATO: nenhum emissor nem entrega ao Recovery (fatia 5 exige contrato novo). NÃO edite à mão: muda aqui = muda na Suite primeiro. Dados 100% sintéticos.
export const RECOVERY_CONTRACT_SECTION = {
  "contractVersion": 1,
  "optedOut": {
    "eventName": "recovery.opted_out.v1",
    "direction": "recovery -> crm",
    "path": "/api/integrations/recovery/opt-out",
    "method": "POST",
    "auth": "Authorization: Bearer <RECOVERY_INTEGRATION_KEY do CRM>; comparação em tempo constante; validada ANTES de ler o corpo",
    "emission": "o Recovery avisa que o casal não quer mais contato. Emissor NÃO existe no Recovery; o receptor do CRM existe, atrás de RECOVERY_ELIGIBILITY_ENABLED (nasce false).",
    "topLevelKeys": [
      "coupleCode",
      "eventId",
      "optedOutAt",
      "source"
    ],
    "rules": {
      "eventId": "string 1..120 sem caracteres de controle (aparada)",
      "coupleCode": "string 1..64 sem caracteres de controle: couples.public_code do Sales (a mesma chave dos demais eventos)",
      "optedOutAt": "UTC (sufixo Z, sem offset) entre 2000-01-01 e 2037-12-31",
      "source": "literal \"recovery\"",
      "pii": "nenhum: sem nome, telefone nem texto livre",
      "idempotency": "por eventId: replay com o mesmo corpo = 200; mesmo eventId com corpo diferente = 409"
    },
    "responses": {
      "201": "aceito",
      "200": "replay idempotente",
      "400": "INVALID_EVENT (corpo fora do schema estrito; corpo lido com limite de 16 KB)",
      "401": "chave ausente ou errada",
      "404": "flag desligada ou sem chave configurada",
      "409": "EVENT_ID_CONFLICT",
      "422": "UNKNOWN_COUPLE_CODE (não reenviável)",
      "503": "EVENT_PROCESSING_FAILED (transitório; o Recovery tenta de novo)"
    },
    "valid": [
      {
        "name": "mínimo válido",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "limites: eventId 120, coupleCode 64, fronteiras 2000 e 2037",
        "event": {
          "eventId": "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
          "coupleCode": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          "optedOutAt": "2037-12-31T23:59:59.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "instante sem milissegundos",
        "event": {
          "eventId": "syn-recovery-optout-0002",
          "coupleCode": "CP-SYN00002",
          "optedOutAt": "2000-01-01T00:00:00Z",
          "source": "recovery"
        }
      }
    ],
    "invalid": [
      {
        "name": "sem eventId",
        "event": {
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "sem coupleCode",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "sem optedOutAt",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "source": "recovery"
        }
      },
      {
        "name": "sem source",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z"
        }
      },
      {
        "name": "chave extra (nome)",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery",
          "name": "Maria"
        }
      },
      {
        "name": "chave extra (phone)",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery",
          "phone": "81999990000"
        }
      },
      {
        "name": "source de outro emissor",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "sales-command"
        }
      },
      {
        "name": "eventId vazio",
        "event": {
          "eventId": "",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "eventId com 121",
        "event": {
          "eventId": "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "eventId com caractere de controle",
        "event": {
          "eventId": "a\u0000b",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "coupleCode vazio",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "coupleCode com 65",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "coupleCode com quebra de linha",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP\nX",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "optedOutAt antes de 2000",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "1999-12-31T23:59:59.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "optedOutAt depois de 2037",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2038-01-01T00:00:00.000Z",
          "source": "recovery"
        }
      },
      {
        "name": "optedOutAt com offset (só UTC)",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T12:00:00-03:00",
          "source": "recovery"
        }
      },
      {
        "name": "optedOutAt só data",
        "event": {
          "eventId": "syn-recovery-optout-0001",
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21",
          "source": "recovery"
        }
      },
      {
        "name": "eventId não string",
        "event": {
          "eventId": 7,
          "coupleCode": "CP-SYN00001",
          "optedOutAt": "2026-10-21T15:00:00.000Z",
          "source": "recovery"
        }
      }
    ]
  },
  "nonBuyerInternalEvents": {
    "direction": "crm (interno) -> recovery (entrega futura)",
    "status": "PREPARAÇÃO: trava só o payload INTERNO sem PII que o CRM já grava em domain_events na mesma transação da transição. O corpo de ENTREGA ao Recovery (crm.non_buyer.eligible.v1 / crm.non_buyer.eligibility_revoked.v1, desenho §4.1/4.2) NÃO está travado: depende da decisão sobre PII (nome/telefone só no momento da entrega) e é a fatia 5 do CRM.",
    "eventIdFormat": "crm-nb-<captureId>-<eligible|revoked>-<seq>, seq inteiro >= 1; igual ao idempotencyKey; determinístico por transição",
    "eligible": {
      "internalEventName": "non_buyer.eligible",
      "topLevelKeys": [
        "branch",
        "captureId",
        "customerId",
        "eventId",
        "seq"
      ],
      "branch": [
        "closed",
        "no_tour"
      ],
      "valid": [
        {
          "name": "branch closed",
          "event": {
            "eventId": "crm-nb-12-eligible-1",
            "captureId": 12,
            "customerId": 7,
            "seq": 1,
            "branch": "closed"
          }
        },
        {
          "name": "branch no_tour, segunda elegibilidade",
          "event": {
            "eventId": "crm-nb-12-eligible-3",
            "captureId": 12,
            "customerId": 7,
            "seq": 3,
            "branch": "no_tour"
          }
        }
      ],
      "invalid": [
        {
          "name": "branch fora do conjunto",
          "event": {
            "eventId": "crm-nb-12-eligible-1",
            "captureId": 12,
            "customerId": 7,
            "seq": 1,
            "branch": "other"
          }
        },
        {
          "name": "eventId não bate com captureId/seq",
          "event": {
            "eventId": "crm-nb-13-eligible-1",
            "captureId": 12,
            "customerId": 7,
            "seq": 1,
            "branch": "closed"
          }
        },
        {
          "name": "seq 0",
          "event": {
            "eventId": "crm-nb-12-eligible-0",
            "captureId": 12,
            "customerId": 7,
            "seq": 0,
            "branch": "closed"
          }
        },
        {
          "name": "PII no corpo (phone)",
          "event": {
            "eventId": "crm-nb-12-eligible-1",
            "captureId": 12,
            "customerId": 7,
            "seq": 1,
            "branch": "closed",
            "phone": "81999990000"
          }
        },
        {
          "name": "sem branch",
          "event": {
            "eventId": "crm-nb-12-eligible-1",
            "captureId": 12,
            "customerId": 7,
            "seq": 1
          }
        }
      ]
    },
    "eligibility_revoked": {
      "internalEventName": "non_buyer.eligibility_revoked",
      "topLevelKeys": [
        "captureId",
        "customerId",
        "eventId",
        "reason",
        "seq"
      ],
      "reason": [
        "anonymized",
        "erasure",
        "opt_out",
        "sale_in_progress",
        "attendance_not_finished"
      ],
      "reasonNote": "IneligibleReason do CRM; com vários motivos vale o de maior prioridade (anonymized, erasure, opt_out, sale_in_progress, attendance_not_finished). sale_validated e notice_invalid do desenho §4.2 ainda NÃO são emitidos.",
      "valid": [
        {
          "name": "opt_out",
          "event": {
            "eventId": "crm-nb-12-revoked-2",
            "captureId": 12,
            "customerId": 7,
            "seq": 2,
            "reason": "opt_out"
          }
        },
        {
          "name": "sale_in_progress",
          "event": {
            "eventId": "crm-nb-12-revoked-4",
            "captureId": 12,
            "customerId": 7,
            "seq": 4,
            "reason": "sale_in_progress"
          }
        }
      ],
      "invalid": [
        {
          "name": "motivo fora do conjunto (sale_validated ainda é da fatia 5)",
          "event": {
            "eventId": "crm-nb-12-revoked-2",
            "captureId": 12,
            "customerId": 7,
            "seq": 2,
            "reason": "sale_validated"
          }
        },
        {
          "name": "eventId de elegível no revogado",
          "event": {
            "eventId": "crm-nb-12-eligible-2",
            "captureId": 12,
            "customerId": 7,
            "seq": 2,
            "reason": "opt_out"
          }
        },
        {
          "name": "branch no revogado",
          "event": {
            "eventId": "crm-nb-12-revoked-2",
            "captureId": 12,
            "customerId": 7,
            "seq": 2,
            "reason": "opt_out",
            "branch": "closed"
          }
        },
        {
          "name": "sem reason",
          "event": {
            "eventId": "crm-nb-12-revoked-2",
            "captureId": 12,
            "customerId": 7,
            "seq": 2
          }
        }
      ]
    },
    "pii": "nenhuma no payload interno (captureId e customerId são ids do CRM)"
  },
  "bridge": {
    "status": "PREPARAÇÃO, só NOMES de variáveis (nunca valores)",
    "flags": {
      "RECOVERY_ELIGIBILITY_ENABLED": "false por padrão no CRM; desligada = nenhum evento, nenhuma entrega, receptor 404"
    },
    "envNames": {
      "RECOVERY_INTEGRATION_KEY": "CRM: chave do Recovery para POST /api/integrations/recovery/opt-out (chave própria do Recovery, não a do Sales)"
    },
    "bridgeConfig": "a saída do CRM para o Recovery entra no resolveBridgeConfig do CRM como uma quarta ponte (par endpoint+chave, mesmo padrão de relationship, salesCancellation e financial; meia configuração = erro de boot). Os nomes das variáveis de saída são definidos pelo CRM nessa fatia e entram aqui no re-pin; nenhum valor é versionado."
  }
};
