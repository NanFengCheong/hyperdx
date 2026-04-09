import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';

import { getConnectionById } from '@/controllers/connection';

export interface TableSchema {
  table: string;
  columns: { name: string; type: string }[];
}

export async function fetchClickHouseSchema(
  teamId: string,
  connectionId: string,
): Promise<TableSchema[]> {
  const connection = await getConnectionById(teamId, connectionId, true);
  if (!connection) {
    throw new Error('Invalid connection');
  }

  const client = new ClickhouseClient({
    host: connection.host,
    username: connection.username,
    password: connection.password,
  });

  // Get all tables
  const tablesResult = await client.query({
    query: 'SHOW TABLES',
    format: 'JSONEachRow',
  });

  const tablesData = await tablesResult.json<{ name: string }>();

  const tables: TableSchema[] = [];

  for (const row of tablesData) {
    const tableName = row.name;
    // Skip system/internal tables
    if (tableName.startsWith('.') || tableName.startsWith('system')) {
      continue;
    }

    const columnsResult = await client.query({
      query: `DESCRIBE TABLE ${tableName}`,
      format: 'JSONEachRow',
    });

    const columnsData = await columnsResult.json<{
      name: string;
      type: string;
    }>();

    tables.push({
      table: tableName,
      columns: columnsData.map(col => ({
        name: col.name,
        type: col.type,
      })),
    });
  }

  return tables;
}

export function buildSchemaPrompt(schema: TableSchema[]): string {
  const lines = ['Available ClickHouse tables and columns:'];

  for (const table of schema) {
    const cols = table.columns.map(c => `${c.name} (${c.type})`).join(', ');
    lines.push(`- ${table.table}: ${cols}`);
  }

  return lines.join('\n');
}
