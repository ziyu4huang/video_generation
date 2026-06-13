import React, { useEffect, useRef } from "react";

export type GalleryTypeFilter = "all" | "image" | "video";

interface GallerySearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  typeFilter: GalleryTypeFilter;
  onTypeFilterChange: (t: GalleryTypeFilter) => void;
  resultCount?: number | null;
}

export function GallerySearchBar({
  query,
  onQueryChange,
  typeFilter,
  onTypeFilterChange,
  resultCount,
}: GallerySearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // `?` key focuses the search bar (when not typing in another input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "?" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const TYPES: { value: GalleryTypeFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "image", label: "Images" },
    { value: "video", label: "Videos" },
  ];

  return (
    <div className="gallery-search-bar">
      <div className="gallery-search-input-wrap">
        <span className="gallery-search-icon">⌕</span>
        <input
          ref={inputRef}
          type="search"
          className="gallery-search-input"
          placeholder="Search by name, prompt, command… (press ?)"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onQueryChange("");
              inputRef.current?.blur();
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="gallery-search-clear"
            onClick={() => { onQueryChange(""); inputRef.current?.focus(); }}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>
      <div className="gallery-filter-chips">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`gallery-filter-chip${typeFilter === t.value ? " active" : ""}`}
            onClick={() => onTypeFilterChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {query && resultCount != null && (
        <span className="gallery-search-count">
          {resultCount} result{resultCount !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
