// tsup `.sql` loader inlines file contents as a string at build time.
declare module "*.sql" {
  const sql: string;
  export default sql;
}
