import axios from 'axios';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { Logger } from '../../../helpers/loggerHelper';
import type { MantecaWidgetOnboarding } from '../../../types/mantecaType';
import { getMantecaAxiosConfig } from '../mantecaCommonService';

export const mantecaWidgetService = {
  async getLinkToOperate(operationOptions: MantecaWidgetOnboarding): Promise<string> {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/widget/onboarding`,
        operationOptions,
        getMantecaAxiosConfig()
      );
      Logger.log('getLinkToOperate', response.data);
      return response.data.url;
    } catch (error) {
      Logger.error('getLinkToOperate', error);
      throw error;
    }
  }
};
