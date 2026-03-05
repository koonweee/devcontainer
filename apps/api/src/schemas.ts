export const BoxSchema = {
  $id: 'Box',
  type: 'object',
  required: [
    'id',
    'name',
    'image',
    'status',
    'containerId',
    'networkName',
    'volumeName',
    'tailnetUrl',
    'createdAt',
    'updatedAt',
    'deletedAt'
  ],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    image: { type: 'string' },
    status: {
      type: 'string',
      enum: ['creating', 'running', 'stopping', 'stopped', 'removing', 'error']
    },
    containerId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    networkName: { type: 'string' },
    volumeName: { type: 'string' },
    tailnetUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    deletedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  }
} as const;

export const JobSchema = {
  $id: 'Job',
  type: 'object',
  required: [
    'id',
    'type',
    'status',
    'boxId',
    'progress',
    'message',
    'error',
    'createdAt',
    'startedAt',
    'finishedAt'
  ],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['create', 'stop', 'remove', 'sync', 'cleanup'] },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    boxId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    progress: { type: 'number' },
    message: { type: 'string' },
    error: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string' },
    startedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    finishedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  }
} as const;

export const CreateBoxBodySchema = {
  type: 'object',
  required: ['name', 'image'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    image: { type: 'string' },
    command: {
      type: 'array',
      items: { type: 'string' }
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' }
    }
  }
} as const;
