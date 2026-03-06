import { Type, type Static } from '@sinclair/typebox';

export const BoxSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    image: Type.String(),
    status: Type.Union([
      Type.Literal('creating'),
      Type.Literal('starting'),
      Type.Literal('running'),
      Type.Literal('stopping'),
      Type.Literal('stopped'),
      Type.Literal('removing'),
      Type.Literal('error')
    ]),
    tailnetUrl: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String()
  },
  { $id: 'Box' }
);

export const JobSchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Union([
      Type.Literal('create'),
      Type.Literal('start'),
      Type.Literal('stop'),
      Type.Literal('remove'),
      Type.Literal('sync'),
      Type.Literal('cleanup')
    ]),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
      Type.Literal('cancelled')
    ]),
    boxId: Type.Union([Type.String(), Type.Null()]),
    progress: Type.Number(),
    message: Type.String(),
    error: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    startedAt: Type.Union([Type.String(), Type.Null()]),
    finishedAt: Type.Union([Type.String(), Type.Null()])
  },
  { $id: 'Job' }
);

export const CreateBoxBodySchema = Type.Object(
  {
    name: Type.String(),
    command: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(Type.String(), Type.String()))
  },
  { additionalProperties: false }
);

export const BoxIdParamsSchema = Type.Object({
  boxId: Type.String()
});

export const JobIdParamsSchema = Type.Object({
  jobId: Type.String()
});

export const BoxLogsQuerySchema = Type.Object({
  follow: Type.Optional(Type.Boolean()),
  since: Type.Optional(Type.String()),
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 }))
});

export const CreateBoxResponseSchema = Type.Object({
  box: Type.Ref(BoxSchema),
  job: Type.Ref(JobSchema)
});

export const TailnetConfigSchema = Type.Object(
  {
    tailnet: Type.String(),
    oauthClientId: Type.String(),
    oauthClientSecret: Type.String(),
    tagsCsv: Type.String(),
    hostnamePrefix: Type.String(),
    authkeyExpirySeconds: Type.Number(),
    createdAt: Type.String(),
    updatedAt: Type.String()
  },
  { $id: 'TailnetConfig' }
);

export const TailnetConfigBodySchema = Type.Object(
  {
    tailnet: Type.String(),
    oauthClientId: Type.String(),
    oauthClientSecret: Type.String(),
    tagsCsv: Type.Optional(Type.String()),
    hostnamePrefix: Type.Optional(Type.String()),
    authkeyExpirySeconds: Type.Optional(Type.Integer({ minimum: 60 }))
  },
  { additionalProperties: false }
);

export type CreateBoxBody = Static<typeof CreateBoxBodySchema>;
export type BoxIdParams = Static<typeof BoxIdParamsSchema>;
export type JobIdParams = Static<typeof JobIdParamsSchema>;
export type BoxLogsQuery = Static<typeof BoxLogsQuerySchema>;
export type TailnetConfigBody = Static<typeof TailnetConfigBodySchema>;
