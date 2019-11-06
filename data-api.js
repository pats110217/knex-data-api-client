const sqlstring = require("sqlstring");
const dataApiClient = require("data-api-client");
const Bluebird = require("bluebird");
const DataAPITransaction = require("./data-api-transaction");

// Call mysql client to setup knex, this set as this function
function dataAPI(ClientRDSDataAPI, Client) {
  Object.setPrototypeOf(ClientRDSDataAPI.prototype, Client.prototype);

  // Add/change prototype functions and properties
  Object.assign(ClientRDSDataAPI.prototype, {
    driverName: "rds-data",

    _driver() {
      // Setup dataApiClient
      return dataApiClient({
        secretArn: this.config.connection.secretArn,
        resourceArn: this.config.connection.resourceArn,
        database: this.config.connection.database,
        region: this.config.connection.region
      });
    },

    transaction() {
      return new DataAPITransaction(this, ...arguments);
    },

    acquireConnection() {
      const connection = this._driver(this.connectionSettings);
      return Bluebird.resolve(connection);
    },

    // Destroy - no connection pool to tear down, so just resolve
    destroy() {
      return Bluebird.resolve();
    },

    // Runs the query on the specified connection, providing the bindings
    // and any other necessary prep work.
    _query(connection, obj) {
      if (!obj || typeof obj === "string") obj = { sql: obj };

      return new Bluebird((resolve, reject) => {
        if (!obj.sql) {
          resolve();
          return;
        }

        // Setup query
        let query = {
          sql: sqlstring.format(obj.sql, obj.bindings), // Remove bidings as Data API doesn't support them
          continueAfterTimeout: true
        };

        // If nestTables is set as true, get result metadata (for table names)
        if (obj.options && obj.options.nestTables) {
          query.includeResultMetadata = true;
        }

        // If in a transaction, add this in
        if (connection.__knexTxId) {
          query.transactionId = connection.__knexTxId;
        }

        connection
          .query(query)
          .then(response => {
            obj.response = response;
            resolve(obj);
          })
          .catch(e => {
            reject(e);
          });
      });
    },

    // Process the response as returned from the query, and format like the standard mysql engine
    processResponse(obj) {
      // Format insert
      if (obj.method === "insert") {
        obj.response = [obj.response.insertId];
      }

      // Format select
      if (obj.method === "select") {
        // If no nested tables
        if (!obj.options || !obj.options.nestTables) {
          obj.response = obj.response.records;
        }
        // Else if nested tables
        else {
          let res = [];
          const metadata = obj.response.columnMetadata;
          const records = obj.response.records;

          // Iterate through the data
          for (let i = 0; i < metadata.length; i++) {
            const tableName = metadata[i].tableName;
            const label = metadata[i].label;

            // Iterate through responses
            for (let j = 0; j < records.length; j++) {
              if (!res[j]) res[j] = {};
              if (!res[j][tableName]) res[j][tableName] = {};
              res[j][tableName][label] = records[j][label];
            }
          }
          obj.response = res;
        }
      }

      // Format delete
      if (obj.method === "del") {
        obj.response = obj.response.numberOfRecordsUpdated;
      }

      return obj.response;
    }
  });
}

module.exports = dataAPI;