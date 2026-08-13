import { createFileRoute } from '@tanstack/react-router';
import NewDomainForm from '@/features/infrastructure/components/new-domain-form';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';

export const Route = createFileRoute('/infrastructure/domains/new')({
  component: NewDomain
});

function NewDomain() {
  return (
    <InfrastructurePage
      title='Declare a domain'
      description='Writes intent and enqueues provisioning. Submitting does not wait on a provider call — the reconciler advances the domain asynchronously.'
    >
      <NewDomainForm />
    </InfrastructurePage>
  );
}
