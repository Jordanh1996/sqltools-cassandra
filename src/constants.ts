import { IDriverAlias } from '@sqltools/types';

/**
 * Aliases for yout driver. EG: PostgreSQL, PG, postgres can all resolve to your driver
 */
export const DRIVER_ALIASES: IDriverAlias[] = [
  { displayName: 'Cassandra', value: 'Cassandra'},
  { displayName: 'Scylla', value: 'Scylla'},
];

export const MAX_ADDITIONAL_COUNTING_TIME = 2000;

export const CASSANDRA_DRIVER_DEFAULT_FETCH_MAX_SIZE = 5000;
