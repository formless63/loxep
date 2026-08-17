import { InfoButton } from '@/components/ui/info-button';
import type { InfobarContent } from '@/components/ui/infobar';

interface HeadingProps {
  title: string;
  description: string;
  infoContent?: InfobarContent;
}

export function Heading({ title, description, infoContent }: HeadingProps) {
  return (
    <div>
      <div className='flex items-center gap-2'>
        <h1 className='text-xl font-semibold tracking-tight'>{title}</h1>
        {infoContent && <InfoButton content={infoContent} />}
      </div>
      <p className='text-muted-foreground text-sm'>{description}</p>
    </div>
  );
}
