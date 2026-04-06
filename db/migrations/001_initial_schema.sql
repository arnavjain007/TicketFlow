-- Migration: initial_schema
-- Creates the core tables required by the chat support system.
-- Matches the column usage in server.js (moderation_log, tickets, chat_messages).

CREATE DATABASE IF NOT EXISTS chatsupport
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE chatsupport;

-- -------------------------------------------------------
-- 1. moderation_log
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_log (
    id                  VARCHAR(255)    NOT NULL PRIMARY KEY,
    conversation_id     VARCHAR(255)    NULL,
    sender              VARCHAR(255)    NULL,
    text                TEXT            NULL,
    original_text       TEXT            NULL,
    teams_message_id    VARCHAR(255)    NULL,
    reply_to_message_id VARCHAR(255)    NULL,
    category            VARCHAR(100)    NULL,
    ticket_id           VARCHAR(255)    NULL,
    original_message_id VARCHAR(255)    NULL,
    message_id          VARCHAR(255)    NULL,
    status              VARCHAR(50)     NOT NULL DEFAULT 'pending',
    moderation_method   VARCHAR(50)     NULL,
    moderation_issues   TEXT            NULL,
    moderation_reason   TEXT            NULL,
    refined_text        TEXT            NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at         DATETIME        NULL,

    INDEX idx_modlog_conversation (conversation_id),
    INDEX idx_modlog_status       (status),
    INDEX idx_modlog_created      (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------
-- 2. tickets
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
    id                  VARCHAR(255)    NOT NULL PRIMARY KEY,
    title               VARCHAR(500)    NULL,
    description         TEXT            NULL,
    chat_summary        TEXT            NULL,
    priority            VARCHAR(50)     NOT NULL DEFAULT 'Medium',
    status              VARCHAR(50)     NOT NULL DEFAULT 'open',
    assigned_to         VARCHAR(255)    NULL,
    assigned_to_name    VARCHAR(255)    NULL,
    category            VARCHAR(255)    NULL,
    conversation_id     VARCHAR(255)    NULL,
    escalation_level    INT             NOT NULL DEFAULT 0,
    escalated_at        DATETIME        NULL,
    resolved_at         DATETIME        NULL,
    last_response_at    DATETIME        NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_tickets_conversation (conversation_id),
    INDEX idx_tickets_status       (status),
    INDEX idx_tickets_created      (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------
-- 3. chat_messages
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
    id                  BIGINT          AUTO_INCREMENT PRIMARY KEY,
    conversation_id     VARCHAR(255)    NULL,
    message_id          VARCHAR(255)    NULL,
    role                VARCHAR(50)     NOT NULL,
    message_text        TEXT            NULL,
    intent              VARCHAR(100)    NULL,
    matched_issue       VARCHAR(500)    NULL,
    issue_summary       TEXT            NULL,
    attachment_summary  TEXT            NULL,
    ticket_id           VARCHAR(255)    NULL,
    file_url            TEXT            NULL,
    file_type           VARCHAR(100)    NULL,
    file_name           VARCHAR(500)    NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_chatmsg_conversation (conversation_id),
    INDEX idx_chatmsg_ticket       (ticket_id),
    INDEX idx_chatmsg_created      (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- DOWN
-- Rollback: drop all tables (DESTRUCTIVE – use with caution)

DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS moderation_log;
