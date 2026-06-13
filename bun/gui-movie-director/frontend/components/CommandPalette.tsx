import React, { useState, useRef, useEffect, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useJobs } from "../hooks/useJobs";

interface Command {
  id: string;
  label: string;
  icon: string;
  group: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  onSelect: (view: { type: string; action?: string }) => void;
}

export function CommandPalette({ open, onClose, commands, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { jobs } = useJobs();

  // Reset query when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlighted(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.id.toLowerCase().includes(query.toLowerCase()) ||
          c.group.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  // Recent failed/running jobs (last 5 non-completed)
  const recentJobs = jobs.slice(0, 5);

  const totalItems = filtered.length + (query ? 0 : recentJobs.length);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => Math.min(h + 1, totalItems - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (highlighted < filtered.length) {
          const cmd = filtered[highlighted];
          if (cmd) {
            onSelect({ type: "command", action: cmd.id });
            onClose();
          }
        }
      }
    },
    [highlighted, filtered, onSelect, onClose, totalItems]
  );

  // Reset highlight when query changes
  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="palette-overlay" />
        <Dialog.Content className="palette-content" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Search commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="palette-list">
            {filtered.length === 0 && (
              <div className="palette-empty">No commands match "{query}"</div>
            )}
            {filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                className={`palette-item${highlighted === i ? " highlighted" : ""}`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => {
                  onSelect({ type: "command", action: cmd.id });
                  onClose();
                }}
              >
                <span className="palette-item-icon">{cmd.icon}</span>
                <span className="palette-item-label">{cmd.label}</span>
                <span className="palette-item-group">{cmd.group}</span>
              </div>
            ))}

            {!query && recentJobs.length > 0 && (
              <>
                <div className="palette-section-title">Recent Jobs</div>
                {recentJobs.map((job, i) => {
                  const idx = filtered.length + i;
                  return (
                    <div
                      key={job.id}
                      className={`palette-item${highlighted === idx ? " highlighted" : ""}`}
                      onMouseEnter={() => setHighlighted(idx)}
                      onClick={() => onClose()}
                    >
                      <span
                        className={`status-dot ${job.status === "running" ? "running" : job.status === "failed" ? "failed" : "ok"}`}
                        style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", flexShrink: 0 }}
                      />
                      <span className="palette-item-label" style={{ fontSize: 12 }}>{job.command}</span>
                      <span className="palette-item-group">{job.status}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <div className="palette-footer">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>Esc close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
