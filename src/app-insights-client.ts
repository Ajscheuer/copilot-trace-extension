import { PublicClientApplication, SilentRequest, InteractionRequiredAuthError } from "@azure/msal-browser";

export interface AppInsightsConfig {
  appId: string;
  clientId: string;
  tenantId: string;
}

let msalInstance: PublicClientApplication | null = null;

function getMsalInstance(config: AppInsightsConfig): PublicClientApplication {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        redirectUri: window.location.origin,
      },
      cache: {
        cacheLocation: "sessionStorage",
      },
    });
  }
  return msalInstance;
}

async function getAppInsightsToken(config: AppInsightsConfig): Promise<string> {
  const msal = getMsalInstance(config);
  await msal.initialize();

  const scopes = ["https://api.applicationinsights.io/Data.Read"];
  const accounts = msal.getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await msal.acquireTokenSilent({ scopes, account: accounts[0] });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        const result = await msal.acquireTokenPopup({ scopes });
        return result.accessToken;
      }
      throw err;
    }
  } else {
    const result = await msal.acquireTokenPopup({ scopes });
    return result.accessToken;
  }
}

export async function queryAppInsights(config: AppInsightsConfig, kql: string): Promise<any[]> {
  const token = await getAppInsightsToken(config);
  const url = `https://api.applicationinsights.io/v1/apps/${config.appId}/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ query: kql }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`App Insights API ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!data.tables || data.tables.length === 0 || data.tables[0].rows.length === 0) {
    return [];
  }

  const table = data.tables[0];
  const colNames = table.columns.map((c: any) => c.name);
  return table.rows.map((row: any[]) => {
    const obj: Record<string, any> = {};
    row.forEach((val: any, i: number) => {
      obj[colNames[i]] = val;
    });
    if (obj.customDimensions && typeof obj.customDimensions === "string") {
      try {
        obj.customDimensions = JSON.parse(obj.customDimensions);
      } catch {}
    }
    return obj;
  });
}
