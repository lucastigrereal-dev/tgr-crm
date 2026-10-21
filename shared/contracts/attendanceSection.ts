// Seção `attendance` do contrato (Sales -> CRM, encounter.attendance_recorded.v1). DONO: tgr-commercial-suite (PR #142); o CRM publica a seção
// idêntica à fixture da Suite (sem `_source`) para fechar o par. NÃO edite à mão: muda aqui = muda na Suite primeiro (ordem Suite -> CRM -> re-pin).
// Dados 100% sintéticos.
export const ATTENDANCE_CONTRACT_SECTION = {
  "contractVersion": 1,
  "eventName": "encounter.attendance_recorded.v1",
  "direction": "sales-command -> crm",
  "path": "/api/integrations/sales-command/encounter-outcome",
  "method": "POST",
  "auth": "Authorization: Bearer <chave de integração>; X-Correlation-Id = correlationId",
  "emission": "um evento por atendimento encerrado, qualquer desfecho; revisão 0 ao encerrar, revisão seguinte a cada correção do desfecho/horário. Emissor NÃO ligado: a flag SALES_ATTENDANCE_TO_CRM nasce desligada e ainda não existe no Sales.",
  "topLevelKeys": [
    "closedAt",
    "correlationId",
    "couple",
    "coupleCode",
    "coupleId",
    "encounterId",
    "eventId",
    "eventName",
    "occurredAt",
    "outcome",
    "project",
    "reasonCode?",
    "revision",
    "source"
  ],
  "projectKeys": [
    "externalKey",
    "name",
    "timezone"
  ],
  "coupleKeys": [
    "phone?",
    "primaryName?",
    "secondaryName?"
  ],
  "outcome": {
    "values": [
      "SALE_CONFIRMED",
      "NO_SALE",
      "CAIU_EM_MESA",
      "NT"
    ],
    "note": "mesmos valores de encounters.outcome no fechamento; VENDEU não é desfecho de fechamento"
  },
  "reasonCode": {
    "type": "string opaca, 1..100, sem caracteres de controle",
    "catalog": "NÃO é enum fechado: o catálogo é configurado por projeto no Sales (nt_reason_configurations.code e motivos do resultado comercial); o CRM guarda como texto opaco e não valida contra lista",
    "allowedWith": [
      "NO_SALE",
      "CAIU_EM_MESA",
      "NT"
    ],
    "forbiddenWith": [
      "SALE_CONFIRMED"
    ],
    "freeText": "reasonText (texto livre) NÃO faz parte deste evento"
  },
  "phone": {
    "type": "string, 1..64, como digitado (couples.phone)",
    "normalization": "o Sales NÃO normaliza nem exige E.164; o CRM deriva os dígitos para casar o casal e não pode recusar formato",
    "optional": true
  },
  "coupleCode": "couples.public_code, 1..32; a mesma chave de encounter.times_recorded.v1",
  "identity": {
    "coupleId": "UUID do casal no Sales (chave canônica junto de project.externalKey)",
    "encounterId": "UUID do atendimento"
  },
  "eventId": {
    "rule": "UUID determinístico (forma v5): sha1('encounter.attendance_recorded.v1:' + encounterId + ':' + revision), versão 5, variante RFC 4122; o receptor DEVE recusar eventId diferente do derivado de (encounterId, revision)",
    "idempotency": "mesmo eventId + mesmo corpo = 200 replay; mesmo eventId + corpo diferente = 409 EVENT_ID_CONFLICT"
  },
  "instantRange": {
    "min": "2000-01-01T00:00:00Z",
    "max": "2037-12-31T23:59:59Z",
    "applies": [
      "occurredAt",
      "closedAt"
    ]
  },
  "pii": "nome e telefone só neste corpo; domain_events do Sales guarda apenas ids e coupleCode; o CRM não devolve esses dados ao Sales",
  "responses": {
    "201": "aceito",
    "200": "replay idempotente",
    "400": "corpo inválido (INVALID_EVENT)",
    "401": "chave errada",
    "404": "integração desligada ou sem chave",
    "409": "EVENT_ID_CONFLICT",
    "422": "projeto desconhecido",
    "503": "indisponível (o Sales tenta de novo)"
  },
  "valid": [
    {
      "eventId": "3090d6d0-e939-5df7-bcbb-818d7390de69",
      "eventName": "encounter.attendance_recorded.v1",
      "source": "sales-command",
      "correlationId": "corr-syn-att0",
      "occurredAt": "2026-10-21T15:00:00.000Z",
      "project": {
        "externalKey": "b0000000-0000-4000-8000-000000000001",
        "name": "Projeto SYN",
        "timezone": "America/Recife"
      },
      "encounterId": "a1111111-1111-4111-8111-111111111111",
      "coupleId": "c0000001-0000-4000-8000-000000000001",
      "coupleCode": "CP-SYN00001",
      "couple": {
        "primaryName": "SYN Ana",
        "secondaryName": "SYN Bruno",
        "phone": "84999990001"
      },
      "outcome": "SALE_CONFIRMED",
      "closedAt": "2026-10-21T14:58:00.000Z",
      "revision": 0
    },
    {
      "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
      "eventName": "encounter.attendance_recorded.v1",
      "source": "sales-command",
      "correlationId": "corr-syn-att1",
      "occurredAt": "2026-10-21T15:00:00.000Z",
      "project": {
        "externalKey": "b0000000-0000-4000-8000-000000000001",
        "name": "Projeto SYN",
        "timezone": "America/Recife"
      },
      "encounterId": "a2222222-2222-4222-8222-222222222222",
      "coupleId": "c0000002-0000-4000-8000-000000000001",
      "coupleCode": "CP-SYN00002",
      "couple": {
        "primaryName": "SYN Carla",
        "phone": "(84) 99999-0002"
      },
      "outcome": "NO_SALE",
      "closedAt": "2026-10-21T14:58:00.000Z",
      "revision": 0,
      "reasonCode": "SEM_INTERESSE"
    },
    {
      "eventId": "a54375dd-2d39-5b49-8b06-c01e8131a952",
      "eventName": "encounter.attendance_recorded.v1",
      "source": "sales-command",
      "correlationId": "corr-syn-att2",
      "occurredAt": "2026-10-21T15:00:00.000Z",
      "project": {
        "externalKey": "b0000000-0000-4000-8000-000000000001",
        "name": "Projeto SYN",
        "timezone": "America/Recife"
      },
      "encounterId": "a3333333-3333-4333-8333-333333333333",
      "coupleId": "c0000003-0000-4000-8000-000000000001",
      "coupleCode": "CP-SYN00003",
      "couple": {
        "primaryName": "SYN Dora"
      },
      "outcome": "CAIU_EM_MESA",
      "closedAt": "2026-10-21T14:58:00.000Z",
      "revision": 0,
      "reasonCode": "VALOR_ENTRADA"
    },
    {
      "eventId": "d524bbb2-e762-5f29-a1ac-66668f5a7501",
      "eventName": "encounter.attendance_recorded.v1",
      "source": "sales-command",
      "correlationId": "corr-syn-att3",
      "occurredAt": "2026-10-21T15:00:00.000Z",
      "project": {
        "externalKey": "b0000000-0000-4000-8000-000000000001",
        "name": "Projeto SYN",
        "timezone": "America/Recife"
      },
      "encounterId": "a4444444-4444-4444-8444-444444444444",
      "coupleId": "c0000004-0000-4000-8000-000000000001",
      "coupleCode": "CP-SYN00004",
      "couple": {},
      "outcome": "NT",
      "closedAt": "2026-10-21T14:58:00.000Z",
      "revision": 0,
      "reasonCode": "FORA_DO_PERFIL"
    },
    {
      "eventId": "259c33ea-7a61-550b-af6a-4a545af237a4",
      "eventName": "encounter.attendance_recorded.v1",
      "source": "sales-command",
      "correlationId": "corr-syn-att1",
      "occurredAt": "2026-10-21T15:00:00.000Z",
      "project": {
        "externalKey": "b0000000-0000-4000-8000-000000000001",
        "name": "Projeto SYN",
        "timezone": "America/Recife"
      },
      "encounterId": "a2222222-2222-4222-8222-222222222222",
      "coupleId": "c0000002-0000-4000-8000-000000000001",
      "coupleCode": "CP-SYN00002",
      "couple": {
        "primaryName": "SYN Carla"
      },
      "outcome": "NO_SALE",
      "closedAt": "2026-10-21T14:58:00.000Z",
      "revision": 1,
      "reasonCode": "SEM_INTERESSE"
    }
  ],
  "invalid": [
    {
      "why": "campo extra",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE",
        "email": "x@example.invalid"
      }
    },
    {
      "why": "campo extra dentro de couple",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002",
          "document": "123"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "outcome desconhecido",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "VENDEU",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "reasonCode com SALE_CONFIRMED",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "SALE_CONFIRMED",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "reasonCode vazio",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": ""
      }
    },
    {
      "why": "reasonCode com mais de 100",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      }
    },
    {
      "why": "eventId que nao e o deterministico",
      "body": {
        "eventId": "00000000-0000-4000-8000-000000000000",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "eventId nao UUID",
      "body": {
        "eventId": "att-1",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "sem coupleCode",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "sem couple",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "telefone com mais de 64",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "99999999999999999999999999999999999999999999999999999999999999999"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "closedAt fora de 2000..2037",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "1999-12-31T23:59:59.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "revision negativa",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": -1,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "source errada",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "crm",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "c0000002-0000-4000-8000-000000000001",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    },
    {
      "why": "coupleId nao UUID",
      "body": {
        "eventId": "611dee36-5d60-54fd-9c25-b1551aee38e7",
        "eventName": "encounter.attendance_recorded.v1",
        "source": "sales-command",
        "correlationId": "corr-syn-att1",
        "occurredAt": "2026-10-21T15:00:00.000Z",
        "project": {
          "externalKey": "b0000000-0000-4000-8000-000000000001",
          "name": "Projeto SYN",
          "timezone": "America/Recife"
        },
        "encounterId": "a2222222-2222-4222-8222-222222222222",
        "coupleId": "casal-1",
        "coupleCode": "CP-SYN00002",
        "couple": {
          "primaryName": "SYN Carla",
          "phone": "(84) 99999-0002"
        },
        "outcome": "NO_SALE",
        "closedAt": "2026-10-21T14:58:00.000Z",
        "revision": 0,
        "reasonCode": "SEM_INTERESSE"
      }
    }
  ]
};
