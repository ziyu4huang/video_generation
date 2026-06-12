import React from "react";

interface InlineErrorProps {
  message: string | null;
  onDismiss?: () => void;
}

/**
 * Dismissible inline error banner — replaces alert() for form errors.
 * Renders nothing when message is null.
 */
export function InlineError({ message, onDismiss }: InlineErrorProps) {
  if (!message) return null;

  return (
    <div className="inline-error">
      <span>❌ {message}</span>
      {onDismiss && (
        <button className="inline-error-dismiss" onClick={onDismiss} aria-label="Dismiss error">
          ×
        </button>
      )}
    </div>
  );
}
