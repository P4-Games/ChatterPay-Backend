export interface chatizaloOperatorReply {
  data_token: string;
  channel_user_id: string;
  message: string;
  message_kind?: 'marketing' | 'utility' | 'auth';
  preferred_language?: 'es' | 'pt' | 'en';
  template_key?: string;
  template_params?: readonly string[];
}
