export interface AppInsightsConfig {
  appId: string;
  apiKey: string;
}

export interface QueryResult {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    rows: any[][];
  }>;
}

/**
 * Query Application Insights using the REST API.
 * Docs: https://dev.applicationinsights.io/documentation/Using-the-API
 */
export async function queryAppInsights(
  config: AppInsightsConfig,
  kql: string
): Promise<any[]> {
  const url = `https://api.applicationinsights.io/v1/apps/${config.appId}/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify({ query: kql }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`App Insights API ${response.status}: ${text}`);
  }

  const data: QueryResult = await response.json();

  if (!data.tables || data.tables.length === 0 || data.tables[0].rows.length === 0) {
    return [];
  }

  // Convert rows + columns into objects
  const table = data.tables[0];
  const colNames = table.columns.map((c) => c.name);

  return table.rows.map((row) => {
    const obj: Record<string, any> = {};
    row.forEach((val, i) => {
      obj[colNames[i]] = val;
    });
    // Parse customDimensions JSON string
    if (obj.customDimensions && typeof obj.customDimensions === "string") {
      try {
        obj.customDimensions = JSON.parse(obj.customDimensions);
      } catch {
        // leave as string
      }
    }
    return obj;
  });
}
