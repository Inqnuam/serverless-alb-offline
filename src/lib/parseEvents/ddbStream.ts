const getTableNameFromResources = (ddbStreamTables: any, Outputs: any, obj: any) => {
  const [key, value] = Object.entries(obj)?.[0];

  if (!key || !value) {
    return;
  }

  if (key == "Fn::GetAtt" || key == "Ref") {
    const [resourceName] = value as unknown as any[];

    const resource = ddbStreamTables[resourceName];
    if (resource) {
      return resource.TableName;
    }
  } else if (key == "Fn::ImportValue" && typeof value == "string") {
    return parseDynamoTableNameFromArn(Outputs?.[value]?.Export?.Name);
  } else if (key == "Fn::Join") {
    const values = value as unknown as any[];
    if (!values.length) {
      return;
    }
    const streamName = values[1][values[1].length - 1];

    if (typeof streamName == "string") {
      return streamName.split("/")[1];
    }
  }
};
const parseDynamoTableNameFromArn = (arn: any) => {
  if (typeof arn === "string") {
    const ddb = arn.split(":")?.[2];
    const TableName = arn.split("/")?.[1];

    if (ddb === "dynamodb" && TableName) {
      return TableName;
    }
  }
};

const getStreamTableInfoFromTableName = (ddbStreamTables: any, tableName: string) => {
  const foundInfo = Object.values(ddbStreamTables).find((x: any) => x.TableName == tableName);

  return foundInfo ?? {};
};
export const parseDdbStreamDefinitions = (Outputs: any, ddbStreamTables: any, event: any) => {
  if (!event || Object.keys(event)[0] !== "stream") {
    return;
  }

  let parsedEvent: any = {};

  const val = Object.values(event)[0] as any;
  const valType = typeof val;

  if (valType == "string") {
    const parsedTableName = parseDynamoTableNameFromArn(val);
    if (parsedTableName) {
      parsedEvent.TableName = parsedTableName;
    }
  } else if (val && !Array.isArray(val) && valType == "object" && (!("enabled" in val) || val.enabled)) {
    const parsedTableName = parseDynamoTableNameFromArn(val.arn);

    if (parsedTableName) {
      parsedEvent.TableName = parsedTableName;
    } else if (val.arn && typeof val.arn == "object") {
      const parsedTableName = getTableNameFromResources(ddbStreamTables, Outputs, val.arn);

      if (parsedTableName) {
        parsedEvent.TableName = parsedTableName;
      }
    }

    if (parsedEvent.TableName) {
      parsedEvent.batchSize = val.batchSize ?? 100;

      if (val.functionResponseType) {
        parsedEvent.functionResponseType = val.functionResponseType;
      }
      if (val.filterPatterns) {
        parsedEvent.filterPatterns = val.filterPatterns;
      }

      if (val.destinations?.onFailure) {
        // TODO: parse destination
        parsedEvent.onFailure = val.destinations.onFailure;
      }
    }
  }

  if (parsedEvent.TableName) {
    const streamInfo = getStreamTableInfoFromTableName(ddbStreamTables, parsedEvent.TableName);

    // @ts-ignore
    parsedEvent = { ...parsedEvent, ...streamInfo };

    if (!("StreamEnabled" in parsedEvent)) {
      parsedEvent.StreamEnabled = true;
    }
    return parsedEvent;
  }
};
