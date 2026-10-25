import express from 'express';
import { config } from './config';
import healthRouter from './routes/health';
import scrapeRouter from './routes/scrape';

const app = express();

app.use(express.json());

app.use('/', healthRouter);
app.use('/', scrapeRouter);

app.listen(config.PORT, () => {
  console.log(`Server running on port ${config.PORT}`);
});

export default app;
