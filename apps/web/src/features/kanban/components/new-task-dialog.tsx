import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger
} from '@/components/ui/responsive-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTaskStore } from '../utils/store';

export default function NewTaskDialog() {
  const addTask = useTaskStore((state) => state.addTask);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const form = e.currentTarget;
    const formData = new FormData(form);
    const { title, description } = Object.fromEntries(formData);

    if (typeof title !== 'string' || typeof description !== 'string') return;
    addTask(title, description);
  };

  return (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger asChild>
        <Button variant='secondary' size='sm'>
          + Add New Task
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className='sm:max-w-[425px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add New Task</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            What do you want to get done today?
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form id='task-form' className='grid gap-4 py-4' onSubmit={handleSubmit}>
          <div className='grid grid-cols-4 items-center gap-4'>
            <Input id='title' name='title' placeholder='Task title...' className='col-span-4' />
          </div>
          <div className='grid grid-cols-4 items-center gap-4'>
            <Textarea
              id='description'
              name='description'
              placeholder='Description...'
              className='col-span-4'
            />
          </div>
        </form>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type='submit' size='sm' form='task-form'>
              Add Task
            </Button>
          </ResponsiveDialogClose>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
