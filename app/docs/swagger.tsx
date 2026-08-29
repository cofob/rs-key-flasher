"use client";

import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
import "./swagger.css";

export function ApiDocumentation() {
  return (
    <main className="swagger-docs" aria-label="RS-Key API documentation">
      <SwaggerUI
        url="/openapi.yml"
        deepLinking
        displayRequestDuration
        persistAuthorization
        tryItOutEnabled
      />
    </main>
  );
}
