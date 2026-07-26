export type SwaraPingMessage = {
  type: 'SWARA_PING';
};

export type SwaraPongMessage = {
  type: 'SWARA_PONG';
  url: string;
  title: string;
};

export type SwaraMessage = SwaraPingMessage | SwaraPongMessage;
