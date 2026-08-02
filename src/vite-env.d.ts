interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: string; query: string }): Record<string, T>;
}
