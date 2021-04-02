import { IBaseQueries } from '@sqltools/types';
import queryFactory from '@sqltools/base-driver/dist/lib/factory';

// Cassandra >= 3.0
const queries = {
  describeTable: queryFactory`
    SELECT * FROM system_schema.tables
    WHERE keyspace_name = '${p => p.database}'
    AND table_name = '${p => p.label}'
    ` as IBaseQueries['describeTable'],
  fetchColumns: queryFactory`
    SELECT keyspace_name, table_name,
    column_name, kind, type
    FROM system_schema.columns
    ` as IBaseQueries['fetchColumns'],
  fetchRecords: queryFactory`
    SELECT * FROM ${p => p.table.schema}.${p => p.table.label} LIMIT ${p => p.limit}
    ` as IBaseQueries['fetchRecords'],
  fetchKeyspaces: queryFactory`
    SELECT keyspace_name FROM system_schema.keyspaces;
    ` as IBaseQueries['fetchSchemas'],
  fetchTables: queryFactory`
    SELECT keyspace_name, table_name
    FROM system_schema.tables;
    SELECT keyspace_name, table_name
    FROM system_schema.columns
    ` as IBaseQueries['fetchTables'],
  fetchFunctions: queryFactory`
    SELECT keyspace_name, function_name,
    argument_names, argument_types,
    return_type, body
    FROM system_schema.functions
    ` as IBaseQueries['fetchFunctions'],
  countRecords: queryFactory`
    SELECT COUNT(*) FROM ${p => p.table.schema}.${p => p.table.label}
    ` as IBaseQueries['countRecords'],
  // TODO
  searchTables: null,
  // TODO
  searchColumns: null,
};

// Cassandra < 3.0
const legacyQueries = {
  describeTable: queryFactory`
    SELECT * FROM system.schema_columnfamilies
    WHERE keyspace_name = '${p => p.database}'
    AND columnfamily_name = '${p => p.label}'
    ` as IBaseQueries['describeTable'],
  fetchColumns: queryFactory`
    SELECT keyspace_name, columnfamily_name AS table_name,
    column_name, type AS kind, validator AS type
    FROM system.schema_columns
    ` as IBaseQueries['fetchColumns'],
  // TODO
  fetchRecords: queryFactory`
    SELECT * FROM ${p => p.table.schema}.${p => p.table.label} LIMIT ${p => p.limit}
    ` as IBaseQueries['fetchRecords'],
  fetchKeyspaces: queryFactory`
    SELECT keyspace_name FROM system.schema_keyspaces;
    ` as IBaseQueries['fetchSchemas'],
  fetchTables: queryFactory`
    SELECT keyspace_name, columnfamily_name AS table_name
    FROM system.schema_columnfamilies;
    SELECT keyspace_name, columnfamily_name AS table_name
    FROM system.schema_columns
    ` as IBaseQueries['fetchTables'],
  fetchFunctions: queryFactory`
    SELECT keyspace_name, function_name,
    argument_names, argument_types,
    return_type, body
    FROM system.schema_functions
    ` as IBaseQueries['fetchFunctions'],
  countRecords: queryFactory`
    SELECT COUNT(*) FROM ${p => p.table.schema}.${p => p.table.label}
    ` as IBaseQueries['countRecords'],
  // TODO
  searchTables: null,
  // TODO
  searchColumns: null,
};

export default {
  queries,
  legacyQueries
};
