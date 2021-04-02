import * as CassandraLib from 'cassandra-driver';
import AbstractDriver from '@sqltools/base-driver';
import get from 'lodash/get';
import Queries from './queries';
import { IConnectionDriver, MConnectionExplorer, NSDatabase, ContextValue, Arg0, IQueryOptions } from '@sqltools/types';
import { v4 as generateId } from 'uuid';
import { CASSANDRA_DRIVER_DEFAULT_FETCH_MAX_SIZE, MAX_ADDITIONAL_COUNTING_TIME } from '../constants';
import { sleep } from './utils';

interface CQLBatch {
  query: string,
  statements: string[],
  options: CassandraLib.QueryOptions,
}

export default class CqlDriver
  extends AbstractDriver<CassandraLib.Client, CassandraLib.ClientOptions>
  implements IConnectionDriver
{
  queries = Queries.queries;
  isLegacy = false;

  public async open() {
    if (this.connection) {
      return this.connection;
    }
    const cqlOptions: CassandraLib.ClientOptions = this.credentials.cqlOptions || {};
    const clientOptions: CassandraLib.ClientOptions = {
      contactPoints: [this.credentials.server],
      keyspace: this.credentials.database ? this.credentials.database : undefined,
      authProvider: new CassandraLib.auth.PlainTextAuthProvider(
        this.credentials.username,
        this.credentials.password
      ),
      protocolOptions: {
        port: this.credentials.port,
      },
      socketOptions: {
        connectTimeout: parseInt(`${this.credentials.connectionTimeout || 5}`, 10) * 1_000,
      },
      policies: {
        loadBalancing: new CassandraLib.policies.loadBalancing.RoundRobinPolicy(),
      },
      ...cqlOptions,
    };
    const conn = new CassandraLib.Client(clientOptions);
    await conn.connect();
    this.connection = Promise.resolve(conn);
    // Check for modern schema support
    const results = await this.query('SELECT keyspace_name FROM system_schema.tables LIMIT 1', {});
    if (results[0].error) {
      this.log.extend('info')('Remote Cassandra database is in legacy mode');
      this.queries = Queries.legacyQueries;
      this.isLegacy = true;
    }
    return this.connection;
  }

  public async close() {
    if (!this.connection) return Promise.resolve();
    const conn = await this.connection;
    await conn.shutdown();
    this.connection = null;
  }

  /**
   * Creates an array of CQL regular statements and batch statements to execute.
   * @param query
   */
  private cqlParse(query: string): (string|CQLBatch)[] {
    // TODO: Use '@sqltools/util/query'
    // const queries = queryParse(query, 'cql');
    const queries = query.split(/\s*;\s*(?=([^']*'[^']*')*[^']*$)/g).filter((v) => !!v && !!`${v}`.trim()).map(v => `${v};`);
    const cqlQueries: (string|CQLBatch)[] = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const found = query.match(
        /^BEGIN\s+(UNLOGGED\s+|COUNTER\s+)?BATCH\s+(?:USING\s+TIMESTAMP\s+(\d+)\s+)?([\s\S]+)$/i
      );

      if (found) {
        const options: CassandraLib.QueryOptions = {};
        if (found[1]) {
          if (found[1].trim().toUpperCase() === 'COUNTER') {
            options.counter = true;
          } else if (found[1].trim().toUpperCase() === 'UNLOGGED') {
            options.logged = false;
          }
        }
        if (found[2]) {
          options.timestamp = parseInt(found[2], 10);
        }
        const batch = {
          query: found[0],
          statements: [found[3]],
          options
        };
        while (true) {
          if (++i == queries.length) {
            throw new Error('Unterminated batch block; include "APPLY BATCH;" at the end');
          }
          const batchQuery = queries[i];
          batch.query += ` ${batchQuery}`;
          if (batchQuery.match(/^APPLY\s+BATCH\s*;?$/i)) {
            cqlQueries.push(batch);
            break;
          } else {
            batch.statements.push(batchQuery);
          }
        }

      } else {
        cqlQueries.push(query);
      }
    }
    return cqlQueries;
  }

  public query: (typeof AbstractDriver)['prototype']['query'] = async (query, opt = {}) => {
    const conn = await this.open();
    const parsedQueries = this.cqlParse(query.toString());
    const results: NSDatabase.IResult[] = [];
    for (let i = 0; i < parsedQueries.length; i++) {
      const q = parsedQueries[i];
      let query: string;
      let result: CassandraLib.types.ResultSet;
      try {
        if (typeof q === 'string') {
          query = q;
          result = await conn.execute(q);
        } else {
          query = q.query;
          result = await conn.batch(q.statements, q.options);
        }
        const cols = result.columns ? result.columns.map(column => column.name) : [];
        const queryresult: NSDatabase.IResult = {
          connId: this.getId(),
          cols,
          messages: [{ date: new Date(), message: `Query ok with ${result.rowLength} result(s)`}],
          query,
          results: result.rows || [],
          requestId: opt.requestId,
          resultId: generateId(),
        };
        results.push(queryresult);
      } catch (e) {
        // Return error and previous queries, as they might have modified data
        const queryresult: NSDatabase.IResult = {
          connId: this.getId(),
          cols: [],
          messages: [e.toString()],
          query,
          results: [],
          error: true,
          requestId: opt.requestId,
          resultId: generateId(),
        };
        results.push(queryresult);
        // continue;
        return results;
      }
    }
    return results;
  }

  public async testConnection() {
    await this.open();
    await this.query('SELECT now() FROM system.local', {});
  }

  /**
   * This method is a helper to generate the connection explorer tree.
   * it gets the child items based on current item
   */
  public async getChildrenForItem({ item, parent }: Arg0<IConnectionDriver['getChildrenForItem']>) {
    switch (item.type) {
      case ContextValue.CONNECTION:
      case ContextValue.CONNECTED_CONNECTION:
        return <MConnectionExplorer.IChildItem[]>await this.getKeyspaces();
      case ContextValue.SCHEMA:
        return <MConnectionExplorer.IChildItem[]>await this.getTables(<NSDatabase.ISchema>item);
      case ContextValue.TABLE:
        return <NSDatabase.IColumn[]>await this.getColumns(<NSDatabase.ITable>item);
    }
    return [];
  }

  /**
   * This method is a helper for intellisense and quick picks.
   */
  public async searchItems(itemType: ContextValue, search: string, { tables }: any = {}): Promise<NSDatabase.SearchableItem[]> {
    switch (itemType) {
      case ContextValue.TABLE:
        return this.getTables();
      case ContextValue.COLUMN:
        const columns = await this.getColumns();

        if (!tables.length) return columns;

        const results = {};

        for (const column of columns) {
          for (const table of tables) {
            if (table.database && column.schema !== table.database) continue;
            if (table.label && column.table !== table.label) continue;
            results[column.label] = column;
          }
        }

        return Object.values(results);
    }
    return [];
  }

  // TODO
  public getStaticCompletions: IConnectionDriver['getStaticCompletions'] = async () => {
    return {};
  }

  public async getKeyspaces(): Promise<NSDatabase.ISchema[]> {
    const [queryResults] = await this.query<any>(this.queries.fetchKeyspaces.raw, {});

    return queryResults.results.map((obj: any) => ({
      label: obj.keyspace_name,
      schema: obj.keyspace_name,
      database: obj.keyspace_name,
      type: ContextValue.SCHEMA,
      iconId: 'group-by-ref-type',
      childType: ContextValue.TABLE
    }));
  }

  public async getTables(parent?: NSDatabase.ISchema): Promise<NSDatabase.ITable[]> {
    const [queryResults, columnsResults] = await this.query<any>(this.queries.fetchTables.raw, {});

    return queryResults.results
      .filter((obj: any) => !parent || parent.label === obj.keyspace_name)
      .map((obj: any) => ({
        label: obj.table_name,
        isView: false,
        schema: obj.keyspace_name,
        database: obj.keyspace_name,
        type: ContextValue.TABLE,
        childType: ContextValue.COLUMN,
      }));
  }
  
  public async getColumns(parent?: NSDatabase.ITable): Promise<NSDatabase.IColumn[]> {
    const [queryResults] = await this.query<any>(this.queries.fetchColumns.raw, {});

    return queryResults.results
      .filter((obj: any) => !parent || parent.label === obj.table_name)
      .map((obj: any) => ({
        label: obj.column_name,
        schema: obj.keyspace_name,
        database: obj.keyspace_name,
        type: ContextValue.COLUMN,
        childType: ContextValue.NO_CHILD,
        dataType: this.isLegacy ? this.mapLegacyTypeToRegularType(obj.type) : obj.type,
        isNullable: obj.kind === 'regular',
        isPk: obj.kind !== 'regular',
        isPartitionKey: obj.kind === 'partition_key',
        table: obj.table_name,
        // tree: [obj.keyspace_name, 'tables', obj.table_name, obj.column_name].join(TREE_SEP)
      }));
  }
  
  /**
   * Turns a legacy Cassandra validator into a human-readable type. Examples:
   * - 'org.apache.cassandra.db.marshal.Int32Type' becomes 'Int32'
   * - 'org.apache.cassandra.db.marshal.SetType(org.apache.cassandra.db.marshal.UTF8Type)'
   *   becomes 'Set(UTF8)'
   * @param legacyType
   */
  private mapLegacyTypeToRegularType(legacyType: string): string {
    return legacyType.replace(/\b\w+\.|Type\b/g, '');
  }
  
  // public async getFunctions(): Promise<NSDatabase.IFunction[]> {
  //   const [queryResults] = await this.query(this.queries.fetchFunctions.raw, {});
  //   return queryResults.results.map((obj: any) => {
  //     const func: NSDatabase.IFunction = {
  //       name: obj.function_name,
  //       schema: obj.keyspace_name,
  //       database: '',
  //       signature: obj.argument_types ? `(${obj.argument_types.join(',')})` : '()',
  //       args: obj.argument_names,
  //       resultType: obj.return_type,
  //       source: obj.body,
  //       tree: [obj.keyspace_name, 'functions', obj.function_name].join(TREE_SEP),
  //     };
  //     return func;
  //   });
  // }
  
  public async describeTable(table: NSDatabase.ITable) {
    return this.query(this.queries.describeTable(table), {});
  }
  
  public async showRecords(table: NSDatabase.ITable, opt: IQueryOptions & { limit: number, page?: number }) {
    const { limit, page = 0 } = opt;
    const offset = page * limit;
    const params = { ...opt, table, offset, limit: offset + limit };
    const recordsP = this.singleQuery(this.queries.fetchRecords(params), opt);
    const countP = this.singleQuery(this.queries.countRecords(params), opt);
    const records = await recordsP;
    records.baseQuery = this.queries.fetchRecords.raw;
    records.pageSize = limit;
    records.page = page;
    records.queryType = 'showRecords';
    records.queryParams = table;
    records.results = records.results.slice(offset);

    const countResult = await Promise.race([countP, sleep(MAX_ADDITIONAL_COUNTING_TIME)]);
    records.total = get(countResult, ['results', '0', 'count', 'low']) || CASSANDRA_DRIVER_DEFAULT_FETCH_MAX_SIZE;

    return [records];
  }
}
