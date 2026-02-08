import { useState, useCallback } from "react";
import { mux } from "../mux-client";

interface InputBarProps {
  target: string;
}

export function InputBar({ target }: InputBarProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (!text.trim() || sending) return;

    setSending(true);
    try {
      await mux.sendInput(target, text);
      setText("");
    } catch (err) {
      console.error("Failed to send input:", err);
    } finally {
      setSending(false);
    }
  }, [target, text, sending]);

  const stop = useCallback(async () => {
    try {
      await mux.interrupt(target);
    } catch (err) {
      console.error("Failed to send interrupt:", err);
    }
  }, [target]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Submit on Enter (without Shift)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send]
  );

  return (
    <div className="input-bar">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        disabled={sending}
        rows={2}
      />
      <div className="input-bar-buttons">
        <button onClick={send} disabled={sending || !text.trim()} className="send-btn">
          Send
        </button>
        <button onClick={stop} className="stop-btn">
          Stop
        </button>
      </div>
    </div>
  );
}
