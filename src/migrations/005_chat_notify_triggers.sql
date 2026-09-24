-- Chat push fan-out over Postgres LISTEN/NOTIFY.
--
-- The listener used to subscribe to row-change INSERT events on chat_messages
-- and order_entity_messages. The database now announces new rows over
-- LISTEN/NOTIFY instead.
--
-- Only the primary key is sent: pg_notify payloads are capped at 8000 bytes and
-- a chat row carries free-text plus a jsonb attachments blob, which can exceed
-- that. The listener re-reads the row by id.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.notify_chat_message_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('chat_message_insert', NEW.id::text);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_order_entity_message_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('order_entity_message_insert', NEW.id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_message_insert_notify ON public.chat_messages;
CREATE TRIGGER trg_chat_message_insert_notify
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_chat_message_insert();

DROP TRIGGER IF EXISTS trg_order_entity_message_insert_notify ON public.order_entity_messages;
CREATE TRIGGER trg_order_entity_message_insert_notify
  AFTER INSERT ON public.order_entity_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_order_entity_message_insert();
