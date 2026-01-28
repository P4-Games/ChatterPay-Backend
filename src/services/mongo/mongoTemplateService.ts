import { TemplateType } from '../../models/templateModel';

export enum templateEnum {
  NOTIFICATIONS = 'notifications', // Enum value for notifications template type
  SECURITY_QUESTIONS = 'security_questions' // Enum value for security questions template type
}

export const mongoTemplateService = {
  /**
   * Retrieves a template of a specific type from the database.
   *
   * @param type - The type of the template to retrieve, specified using templateEnum.
   * @returns The template corresponding to the provided type, or null if not found.
   */
  getTemplate: async <T>(type: templateEnum): Promise<T | null> => {
    // Query the TemplateType collection to get the template based on the type
    const template = await TemplateType.findOne({}, { [type]: 1 });

    // If a template is found, return the value of the requested field, cast to type T
    // Otherwise, return null
    return template ? (template[type] as T) : null;
  }
};
