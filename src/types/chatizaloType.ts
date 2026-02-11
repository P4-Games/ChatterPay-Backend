export interface chatizaloOperatorReply {
  data_token: string;
  channel_user_id: string;
  message: string;
  message_kind?: 'marketing' | 'utility' | 'auth';
  preferred_language?: 'es' | 'pt' | 'en';
  template_key?: string;
  template_params?: readonly string[];
}

export interface chatizaloButtonOption {
  id: string;
  title: string;
}

export interface chatizaloInteractiveUrlCta {
  type: 'url_cta';
  header_text?: string;
  body_text: string;
  footer_text?: string;
  button_text: string;
  url: string;
}

export interface chatizaloInteractiveButton {
  type: 'button';
  header_text?: string;
  body_text: string;
  footer_text?: string;
  buttons: chatizaloButtonOption[];
}

export interface chatizaloInteractiveMessage {
  data_token: string;
  channel_user_id: string;
  message: chatizaloInteractiveUrlCta | chatizaloInteractiveButton;
}
