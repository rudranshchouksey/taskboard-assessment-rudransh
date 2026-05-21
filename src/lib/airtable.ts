import Airtable from "airtable";

export function isAirtableConfigured(): boolean {
  return !!(
    process.env.AIRTABLE_API_KEY &&
    process.env.AIRTABLE_BASE_ID &&
    process.env.AIRTABLE_TABLE_NAME
  );
}

/**
 * Returns a configured Airtable table handle.
 * Throws if any required env var is missing — call isAirtableConfigured() first.
 */
export function getAirtableTable() {
  const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
    throw new Error(
      "Set AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and AIRTABLE_TABLE_NAME before calling getAirtableTable."
    );
  }
  return new Airtable({ apiKey: AIRTABLE_API_KEY })
    .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME);
}
