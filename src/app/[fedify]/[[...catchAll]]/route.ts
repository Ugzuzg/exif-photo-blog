import { federation, integrateFederation } from '@/shared/integrate-fedify';
const requestHanlder = integrateFederation(federation, () => {});

export {
  requestHanlder as DELETE,
  requestHanlder as GET,
  requestHanlder as PATCH,
  requestHanlder as POST,
  requestHanlder as PUT,
};
