import { TemplateType } from '../models/templates';

export enum templateEnum {
  NOTIFICATIONS = 'notifications'
}

/**
 * Gets template.
 */
export const getTemplate = async <T>(type: templateEnum): Promise<T | null> => {
  const template = await TemplateType.findOne({}, { [type]: 1 });
  return template ? (template[type] as T) : null;
};
