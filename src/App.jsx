import { useState, useCallback, useEffect, useRef } from "react";
import JSZip from "jszip";

// ─── CONSTANTS ──────────────────────────────────────────────
const LOCATION_DATA = `<?xml version="1.0" encoding="UTF-8"?>\r\n<xml-fragment xmlns:proj="http://www.bea.com/wli/config/project">\r\n    <proj:description/>\r\n    <proj:isImmutable>false</proj:isImmutable>\r\n</xml-fragment>`;

const DATA_CLASSES = {
  LocationData: "com.bea.wli.config.project.impl.LocationDataImpl",
  XMLSchema: "com.bea.wli.sb.resources.config.impl.SchemaEntryDocumentImpl",
  WSDL: "com.bea.wli.sb.resources.config.impl.WsdlEntryDocumentImpl",
  WADL: "com.bea.wli.sb.resources.config.impl.WadlEntryDocumentImpl",
  ProxyService: "com.bea.wli.sb.services.impl.ProxyServiceEntryDocumentImpl",
  Pipeline: "com.bea.wli.sb.pipeline.config.impl.PipelineEntryDocumentImpl",
  BusinessService: "com.oracle.xmlns.servicebus.business.config.impl.BusinessServiceEntryDocumentImpl",
  Xquery: "com.bea.wli.sb.resources.config.impl.XqueryEntryDocumentImpl",
};

function generateExportInfo(files, config) {
  const { projectName, serviceName, proxyName, serviceType, siebelWsdlRef, isDmz, dmzNxsdName, dmzChannels } = config;
  const buildId = `OSB-IDE_build_${Date.now()}`;
  const now = new Date().toString();
  const p = projectName;

  const extRef = (typeId, instancePath) => `${typeId}$${instancePath.replace(/\//g, "$")}`;

  const getExtRefs = (path) => {
    const refs = [];

    if (isDmz) {
      // DMZ ProxyService → WSDL, Pipeline, PS WADL
      if (path.endsWith(".ProxyService")) {
        refs.push(extRef("WSDL", `${p}/wsdl/${serviceName}`));
        refs.push(extRef("Pipeline", `${p}/proxy/${serviceName}PSPipeline`));
        refs.push(extRef("WADL", `${p}/Resources/${serviceName}PS`));
      }
      // DMZ Pipeline → WSDL, BS, NXSD, CommonSBProject refs
      if (path.endsWith(".Pipeline")) {
        refs.push(extRef("WSDL", `${p}/wsdl/${serviceName}`));
        refs.push(extRef("BusinessService", `${p}/business/${serviceName}BS`));
        refs.push(extRef("XMLSchema", `${p}/schema/${dmzNxsdName || `nxsd_${serviceName}`}`));
        // CommonSBProject external refs
        refs.push(extRef("Archive", "CommonSBProject/jar/CryptLib"));
        refs.push(extRef("ProxyService", "CommonSBProject/proxy/BinaryText"));
        refs.push(extRef("ProxyService", "OAMConsumerUserProfileSBProject/proxy/ConsumerUserProfileMailLocalPS"));
        refs.push(extRef("ProxyService", "OAMConsumerUserProfileSBProject/proxy/ConsumerUserProfileMobileLocalPS"));
        if (dmzChannels && dmzChannels.b2b) {
          refs.push(extRef("ProxyService", "OAMB2BUserProfileSBProject/proxy/LocalB2BUserProfilePS"));
        }
        if (dmzChannels && dmzChannels.ssf) {
          refs.push(extRef("ProxyService", "OAMSSFUserProfileSBProject/proxy/SSFUserProfilePS_Local"));
        }
      }
      // DMZ BusinessService → BS WSDL, BS WADL, ServiceAccount
      if (path.endsWith(".BusinessService")) {
        refs.push(extRef("WSDL", `${p}/Resources/${serviceName}BS`));
        refs.push(extRef("ServiceAccount", "CommonSBProject/serviceaccount/SecurityServiceAccount"));
        refs.push(extRef("WADL", `${p}/Resources/${serviceName}BS`));
      }
      // DMZ BS WSDL → Schema
      if (path === `${p}/Resources/${serviceName}BS.WSDL`) {
        refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
      }
      // DMZ BS WADL → Schema
      if (path === `${p}/Resources/${serviceName}BS.WADL`) {
        refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
      }
      // DMZ PS WADL → Schema
      if (path === `${p}/Resources/${serviceName}PS.WADL`) {
        refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
      }
      // DMZ App WSDL → Schema
      if (path === `${p}/wsdl/${serviceName}.WSDL`) {
        refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
      }
      // NXSD Schema — no external refs
      return refs;
    }

    // App Layer refs (original logic)
    // App WSDL → Schema
    if (path === `${p}/wsdl/${serviceName}.WSDL`) {
      refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
    }
    // WADL → Schema
    if (path.endsWith(".WADL")) {
      refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
    }
    // ProxyService → WSDL, Pipeline, WADL
    if (path.endsWith(".ProxyService")) {
      refs.push(extRef("WSDL", `${p}/wsdl/${serviceName}`));
      refs.push(extRef("Pipeline", `${p}/proxy/${config.pipelineName}`));
      refs.push(extRef("WADL", `${p}/Resources/${proxyName}`));
    }
    // Pipeline → WSDL, XQueries, routing target (always uses operations array)
    if (path.endsWith(".Pipeline")) {
      refs.push(extRef("WSDL", `${p}/wsdl/${serviceName}`));
      if (config.operations && config.operations.length > 0) {
        config.operations.forEach(op => {
          refs.push(extRef("Xquery", `${p}/transformation/${op.operationName}RequestXQ`));
          refs.push(extRef("Xquery", `${p}/transformation/${op.operationName}ResponseXQ`));
          if (op.serviceType === "ODS") {
            refs.push(extRef("ProxyService", "CommonSBProject/proxy/LocalSiebelQueryToDBPS"));
          } else {
            refs.push(extRef("BusinessService", `${p}/business/${op.operationName}BS`));
          }
        });
      } else {
        // Fallback for legacy single-op config
        refs.push(extRef("Xquery", `${p}/transformation/${serviceName}RequestXQ`));
        refs.push(extRef("Xquery", `${p}/transformation/${serviceName}ResponseXQ`));
        if (serviceType === "ODS") {
          refs.push(extRef("ProxyService", "CommonSBProject/proxy/LocalSiebelQueryToDBPS"));
        } else {
          refs.push(extRef("BusinessService", `${p}/business/${serviceName}BS`));
        }
      }
    }
    // BusinessService → Siebel WSDL in Resources
    // Multi-op: match per-op BS to its specific WSDL ref
    if (path.endsWith(".BusinessService")) {
      if (config.operations && config.operations.length > 1) {
        const matchedOp = config.operations.find(op => path.includes(`${op.operationName}BS`));
        const ref = matchedOp?.siebelWsdlRef || siebelWsdlRef;
        if (ref) refs.push(extRef("WSDL", `${p}/Resources/${ref}`));
      } else if (siebelWsdlRef) {
        refs.push(extRef("WSDL", `${p}/Resources/${siebelWsdlRef}`));
      }
    }
    // Request XQ → Schema (+ Siebel WSDL for Siebel)
    // Multi-op: match per-op XQ to its specific type and WSDL ref
    if (path.includes("RequestXQ.Xquery")) {
      refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
      if (config.operations && config.operations.length > 1) {
        const matchedOp = config.operations.find(op => path.includes(`${op.operationName}RequestXQ`));
        if (matchedOp?.serviceType === "Siebel" && matchedOp?.siebelWsdlRef) {
          refs.push(extRef("WSDL", `${p}/Resources/${matchedOp.siebelWsdlRef}`));
        }
      } else if (serviceType === "Siebel" && siebelWsdlRef) {
        refs.push(extRef("WSDL", `${p}/Resources/${siebelWsdlRef}`));
      }
    }
    // Response XQ → Schema (+ Siebel WSDL for Siebel)
    if (path.includes("ResponseXQ.Xquery")) {
      refs.push(extRef("XMLSchema", `${p}/schema/${serviceName}`));
      if (config.operations && config.operations.length > 1) {
        const matchedOp = config.operations.find(op => path.includes(`${op.operationName}ResponseXQ`));
        if (matchedOp?.serviceType === "Siebel" && matchedOp?.siebelWsdlRef) {
          refs.push(extRef("WSDL", `${p}/Resources/${matchedOp.siebelWsdlRef}`));
        }
      } else if (serviceType === "Siebel" && siebelWsdlRef) {
        refs.push(extRef("WSDL", `${p}/Resources/${siebelWsdlRef}`));
      }
    }
    return refs;
  };

  const items = files.map(f => {
    const ext = f.path.split(".").pop();
    const typeId = ext;
    const instanceId = f.path.endsWith(".LocationData")
      ? f.path.replace(".LocationData", "")
      : f.path.replace(/\.[^.]+$/, "");
    const dataclass = DATA_CLASSES[typeId] || "";
    const refs = getExtRefs(f.path);
    const isLoc = typeId === "LocationData";

    let props = "";
    props += `<imp:property name="representationversion" value="0"/>\n`;
    props += `<imp:property name="dataclass" value="${dataclass}"/>\n`;
    props += `<imp:property name="isencrypted" value="false"/>\n`;
    props += `<imp:property name="jarentryname" value="${f.path}"/>\n`;
    if (isLoc) {
      props += `<imp:property name="custom _special_data_class" value="${dataclass}"/>\n`;
    }
    refs.forEach(r => {
      props += `<imp:property name="extrefs" value="${r}"/>\n`;
    });

    return `<imp:exportedItemInfo instanceId="${instanceId}" typeId="${typeId}">\n<imp:properties>\n${props}</imp:properties>\n</imp:exportedItemInfo>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<xml-fragment name="${buildId}" version="v2" xmlns:imp="http://www.bea.com/wli/config/importexport">
<imp:properties>
<imp:property name="username" value="ServiceBus"/>
<imp:property name="description" value=""/>
<imp:property name="exporttime" value="${now}"/>
<imp:property name="productname" value="Oracle Service Bus"/>
<imp:property name="productversion" value="12.2.1.3.0"/>
<imp:property name="projectLevelExport" value="true"/>
</imp:properties>
${items}
</xml-fragment>`;
}

const SCENARIOS = [
  { id: 1, label: "New / Existing Project + New Service", desc: "Generate service files — works for both new and existing projects" },
  { id: 3, label: "Existing Service + New Operation", desc: "Add operation to existing service" },
  { id: 4, label: "Hybrid Routing", desc: "Single pipeline routing to both ODS & Siebel" },
];

const ENVIRONMENTS = ["UAT", "PRD", "SIT", "DEV"];
const ENV_CONFIG = {
  DEV: {
    uriEnvCode: "TST",
    siebelEndpoint: "https://10.59.7.118:9004/siebel/app/eai_anon/enu?SWEExtSource=AnonWebService&SWEExtCmd=Execute",
    appLayerBaseUrl: "http://10.59.7.78:8005",
  },
  SIT: {
    uriEnvCode: "UAT",
    siebelEndpoint: "https://10.59.17.86/siebel/app/eai_anon/enu?SWEExtSource=AnonWebService&SWEExtCmd=Execute",
    appLayerBaseUrl: "http://10.59.17.81",
  },
  UAT: {
    uriEnvCode: "UAT",
    siebelEndpoint: "https://10.59.17.88/siebel/app/eai_anon/enu?SWEExtSource=AnonWebService&SWEExtCmd=Execute",
    appLayerBaseUrl: "http://10.59.17.65",
  },
  PRD: {
    uriEnvCode: "PRD",
    siebelEndpoint: "https://10.58.16.205/siebel/app/eai_anon/enu?SWEExtSource=AnonWebService&SWEExtCmd=Execute",
    appLayerBaseUrl: "http://10.58.16.193",
  },
};
const SIEBEL_ENDPOINTS = Object.fromEntries(Object.entries(ENV_CONFIG).map(([k, v]) => [k, v.siebelEndpoint]));
const TIMEOUT_CONFIG = {
  appSiebelBS: { connectionTimeout: 20, readTimeout: 30 },
  dmzBS: { connectionTimeout: 10, readTimeout: 30 },
  retryCount: 0,
  retryInterval: 30,
};

// ─── DEFAULT OPERATION FACTORY ───────────────────────────────
const createDefaultOp = (opName = "") => ({
  operationName: opName,
  requestElement: opName ? `${opName}Request` : "",
  responseElement: opName ? `${opName}Response` : "",
  serviceType: "ODS",
  requestFields: [{ name: "TrackingId", type: "string", optional: false, isList: false, children: [], odsMapping: "", siebelMapping: "" }],
  responseFields: [
    { name: "ErrorCode", type: "string", optional: false, isList: false, children: [], odsMapping: "Error_spcCode", siebelMapping: "Error_spcCode" },
    { name: "ErrorMessage", type: "string", optional: false, isList: false, children: [], odsMapping: "Error_spcMessage", siebelMapping: "Error_spcMessage" },
    { name: "TrackingId", type: "string", optional: false, isList: false, children: [], odsMapping: "", siebelMapping: "" },
  ],
  odsServiceId: "",
  odsRequestElement: "",
  odsResponseElement: "",
  siebelWsdlRef: "",
  siebelInputElement: "",
  siebelOutputElement: "",
  siebelPortName: "",
  siebelEndpointUrl: SIEBEL_ENDPOINTS["UAT"],
  siebelWsdlRaw: "",
  siebelWsdlParsed: false,
  siebelInputFields: [],
  siebelOutputFields: [],
  odsRequestSample: "",
  odsResponseSample: "",
  parsedOdsReqFields: null,
  parsedOdsResFields: null,
  manualEdits: {},
});

// ─── XML VALIDATION ─────────────────────────────────────────
function validateXmlString(xmlString) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, "text/xml");
    const err = doc.querySelector("parsererror");
    if (err) return { valid: false, error: err.textContent.split("\n")[0] };
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ─── XML ESCAPE ─────────────────────────────────────────────
function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ─── ID GENERATOR ───────────────────────────────────────────
function generateId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `_ActionId-${seg(7)}.N${seg(8)}.0.${seg(13)}.N${seg(4)}`;
}

function generateStageId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `_StageId-${seg(7)}.N${seg(8)}.0.${seg(13)}.N${seg(4)}`;
}

function generateFlowId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `_FlowId-${seg(7)}.N${seg(8)}.0.${seg(13)}.N${seg(4)}`;
}

function generateBranchId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `_BranchId-${seg(7)}.N${seg(8)}.0.${seg(13)}.N${seg(4)}`;
}

function generatePipelineId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `${seg(7)}.N${seg(8)}.0.${seg(13)}.N${seg(4)}`;
}

// ─── FILE GENERATORS ────────────────────────────────────────

function generateSchema(config) {
  const { serviceName, namespace, requestElement, responseElement, requestFields, responseFields } = config;
  
  const renderField = (f) => {
    if (f.isList && f.children && f.children.length > 0) {
      const childFields = f.children.map(c =>
        `              <xsd:element name="${c.name}" type="xsd:string" minOccurs="0"/>`
      ).join("\n");
      return `        <xsd:element name="${f.name}" minOccurs="0" maxOccurs="unbounded">
          <xsd:complexType>
            <xsd:sequence>
${childFields}
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>`;
    }
    if (f.isGroup && f.children && f.children.length > 0) {
      const childFields = f.children.map(c => renderField(c)).join("\n");
      return `        <xsd:element name="${f.name}" minOccurs="0">
          <xsd:complexType>
            <xsd:sequence>
${childFields}
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>`;
    }
    return `        <xsd:element name="${f.name}" type="xsd:${f.type || 'string'}" minOccurs="0"/>`;
  };

  const reqFields = requestFields.map(renderField).join("\n");
  const resFields = responseFields.map(renderField).join("\n");

  const xsd = `<?xml version="1.0" encoding="windows-1252"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
            xmlns="${namespace}"
            targetNamespace="${namespace}"
            elementFormDefault="qualified">

  <xsd:element name="${requestElement}">
    <xsd:complexType>
      <xsd:sequence>
${reqFields}
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>

  <xsd:element name="${responseElement}">
    <xsd:complexType>
      <xsd:sequence>
${resFields}
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>

</xsd:schema>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:schemaEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:schema><![CDATA[${xsd}]]></con:schema>
    <con:targetNamespace>${namespace}</con:targetNamespace>
</con:schemaEntry>`;
}

function generateWsdl(config) {
  const { serviceName, namespace, requestElement, responseElement, operationName, bindingName, portTypeName } = config;
  
  const wsdl = `<wsdl:definitions name="${serviceName}" targetNamespace="${namespace}" xmlns:tns="${namespace}" xmlns:inp1="${namespace}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
    <wsdl:types>
        <xsd:schema>
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
    </wsdl:types>
    <wsdl:message name="requestMessage">
        <wsdl:part name="requestMessage" element="tns:${requestElement}"/>
    </wsdl:message>
    <wsdl:message name="replyMessage">
        <wsdl:part name="responseMessage" element="tns:${responseElement}"/>
    </wsdl:message>
    <wsdl:portType name="${portTypeName}">
        <wsdl:operation name="${operationName}">
            <wsdl:input message="tns:requestMessage"/>
            <wsdl:output message="tns:replyMessage"/>
        </wsdl:operation>
    </wsdl:portType>
    <wsdl:binding name="${bindingName}" type="tns:${portTypeName}">
        <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
        <wsdl:operation name="${operationName}">
            <soap:operation style="document" soapAction="${operationName}"/>
            <wsdl:input>
                <soap:body use="literal" namespace="${namespace}"/>
            </wsdl:input>
            <wsdl:output>
                <soap:body use="literal" namespace="${namespace}"/>
            </wsdl:output>
        </wsdl:operation>
    </wsdl:binding>
</wsdl:definitions>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wsdlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wsdl><![CDATA[${wsdl}]]></con:wsdl>
    <con:dependencies>
        <con:schemaRef isInclude="false" schemaLocation="../schema/${serviceName}.xsd" namespace="${namespace}" ref="${config.projectName}/schema/${serviceName}"/>
    </con:dependencies>
    <con:targetNamespace>${namespace}</con:targetNamespace>
</con:wsdlEntry>`;
}

function generateWadl(config) {
  const { serviceName, namespace, requestElement, responseElement, operationName, proxyName, projectName } = config;
  
  const wadl = `<application xmlns:soa="http://www.oracle.com/soa/rest" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="${namespace}" xmlns="http://wadl.dev.java.net/2009/02">
   <doc title="${proxyName}">RestService</doc>
   <grammars>
      <xsd:schema xmlns:inp1="${namespace}" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
   </grammars>
   <resources>
      <resource path="/">
         <method name="POST" soa:wsdlOperation="${operationName}">
            <request>
               <representation mediaType="application/json" element="cns:${requestElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${requestElement}" xmlns:cns="${namespace}"/>
            </request>
            <response status="200">
               <representation mediaType="application/json" element="cns:${responseElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${responseElement}" xmlns:cns="${namespace}"/>
            </response>
         </method>
      </resource>
   </resources>
</application>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wadlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wadl><![CDATA[${wadl}]]></con:wadl>
    <con:dependencies>
        <con:importSchema namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
</con:wadlEntry>`;
}

function generateProxyService(config) {
  const { serviceName, namespace, bindingName, proxyName, projectName, uriPath, authPolicy, pipelineName } = config;
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<ser:proxyServiceEntry xmlns:ser="http://www.bea.com/wli/sb/services" xmlns:con="http://www.bea.com/wli/sb/services/security/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:oper="http://xmlns.oracle.com/servicebus/proxy/operations" xmlns:tran="http://www.bea.com/wli/sb/transports" xmlns:env="http://www.bea.com/wli/config/env">
    <ser:coreEntry isAutoPublish="false">
        <ser:description>This service was created by the REST adapter</ser:description>
        <ser:security>
            <con:access-control-policies>
                <con:transport-level-policy xsi:type="con1:ProviderPolicyContainerType" xmlns:con1="http://www.bea.com/wli/sb/security/accesscontrol/config">
                    <con1:policy provider-id="XACMLAuthorizer">
                        <con1:policy-expression>${authPolicy}</con1:policy-expression>
                    </con1:policy>
                </con:transport-level-policy>
            </con:access-control-policies>
        </ser:security>
        <ser:binding type="REST" xsi:type="con:RestBindingType" xmlns:con="http://www.bea.com/wli/sb/services/bindings/config">
            <con:wsdl ref="${projectName}/wsdl/${serviceName}"/>
            <con:binding>
                <con:name>${bindingName}</con:name>
                <con:namespace>${namespace}</con:namespace>
            </con:binding>
            <con:wadl ref="${projectName}/Resources/${proxyName}"/>
        </ser:binding>
        <oper:operations enabled="true"/>
        <ser:ws-policy>
            <ser:binding-mode>no-policies</ser:binding-mode>
        </ser:ws-policy>
        <ser:invoke ref="${projectName}/proxy/${pipelineName}" xsi:type="con:PipelineRef" xmlns:con="http://www.bea.com/wli/sb/pipeline/config"/>
        <ser:xqConfiguration>
            <ser:snippetVersion>1.0</ser:snippetVersion>
        </ser:xqConfiguration>
    </ser:coreEntry>
    <ser:endpointConfig>
        <tran:provider-id>http</tran:provider-id>
        <tran:inbound>true</tran:inbound>
        <tran:URI>
            <env:value>${uriPath}</env:value>
        </tran:URI>
        <tran:inbound-properties/>
        <tran:provider-specific xsi:type="http:HttpEndPointConfiguration" xmlns:http="http://www.bea.com/wli/sb/transports/http">
            <http:inbound-properties>
                <http:client-authentication xsi:type="http:HttpBasicAuthenticationType"/>
            </http:inbound-properties>
            <http:compression>
                <http:compression-support>false</http:compression-support>
            </http:compression>
        </tran:provider-specific>
    </ser:endpointConfig>
</ser:proxyServiceEntry>`;
}

function generateRequestXQ_ODS(config) {
  const { serviceName, namespace, requestElement, requestFields, projectName, odsRequestElement } = config;
  const odsNs = "http://ods.com/CustomUI";

  const simpleFieldMappings = requestFields.filter(f => !f.isList && !f.isGroup && f.odsMapping).map(f => {
    return `    <cus:${f.odsMapping}>{fn:data($inputRequest/ns1:${f.name})}</cus:${f.odsMapping}>`;
  }).join("\n");

  const groupFieldMappings = requestFields.filter(f => f.isGroup && f.children?.length > 0).map(f => {
    if (f.odsMapping) {
      const childMappings = f.children.filter(c => c.odsMapping).map(c => {
        return `      <cus:${c.odsMapping}>{fn:data($inputRequest/ns1:${f.name}/ns1:${c.name})}</cus:${c.odsMapping}>`;
      }).join("\n");
      return `    <cus:${f.odsMapping}>\n${childMappings}\n    </cus:${f.odsMapping}>`;
    }
    return f.children.filter(c => c.odsMapping).map(c => {
      return `    <cus:${c.odsMapping}>{fn:data($inputRequest/ns1:${f.name}/ns1:${c.name})}</cus:${c.odsMapping}>`;
    }).join("\n");
  }).join("\n");

  const fieldMappings = [simpleFieldMappings, groupFieldMappings].filter(Boolean).join("\n");

  const xq = `xquery version "1.0" encoding "utf-8";

(:: OracleAnnotationVersion "1.0" ::)

declare namespace cus="${odsNs}";
declare namespace ns1="${namespace}";
(:: import schema at "../schema/${serviceName}.xsd" ::)

declare variable $inputRequest as element() (:: schema-element(ns1:${requestElement}) ::) external;

declare function local:func($inputRequest as element() (:: schema-element(ns1:${requestElement}) ::)) {
   <cus:${odsRequestElement}>
${fieldMappings}
</cus:${odsRequestElement}>
};

local:func($inputRequest)`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:xqueryEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:xquery><![CDATA[${xq}]]></con:xquery>
    <con:dependencies>
        <con:importSchema location="../schema/${serviceName}.xsd">
            <con:schema ref="${projectName}/schema/${serviceName}"/>
        </con:importSchema>
    </con:dependencies>
</con:xqueryEntry>`;
}

function generateResponseXQ_ODS(config) {
  const { serviceName, namespace, responseElement, responseFields, projectName, odsResponseElement } = config;
  const odsNs = "http://ods.com/CustomUI";

  const simpleFields = responseFields.filter(f => !f.isList && !f.isGroup && f.odsMapping).map(f => {
    return `    <ns:${f.name}>{fn:data($reqMsg/cus:${f.odsMapping})}</ns:${f.name}>`;
  }).join("\n");

  const groupFields = responseFields.filter(f => f.isGroup && f.children?.length > 0).map(f => {
    if (f.odsMapping) {
      const childMappings = f.children.filter(c => c.odsMapping).map(c => {
        return `      <ns:${c.name}>{fn:data($reqMsg/cus:${f.odsMapping}/cus:${c.odsMapping})}</ns:${c.name}>`;
      }).join("\n");
      return `    <ns:${f.name}>\n${childMappings}\n    </ns:${f.name}>`;
    }
    const childMappings = f.children.filter(c => c.odsMapping).map(c => {
      return `      <ns:${c.name}>{fn:data($reqMsg/cus:${c.odsMapping})}</ns:${c.name}>`;
    }).join("\n");
    return `    <ns:${f.name}>\n${childMappings}\n    </ns:${f.name}>`;
  }).join("\n");

  const listFields = responseFields.filter(f => f.isList && f.odsMapping && f.children).map(f => {
    const odsItemName = f.odsItemName || f.name.replace(/List$/, "");
    const childMappings = f.children.filter(c => c.odsMapping).map(c => {
      return `          <ns:${c.name}>{fn:data($item/cus:${c.odsMapping})}</ns:${c.name}>`;
    }).join("\n");
    return `    {
      for $item in $reqMsg/cus:${f.odsMapping}/cus:${odsItemName}
      return
        <ns:${f.name}>
${childMappings}
        </ns:${f.name}>
    }`;
  }).join("\n\n");

  const xq = `xquery version "1.0" encoding "utf-8";

(:: OracleAnnotationVersion "1.0" ::)

declare namespace cus="${odsNs}";
declare namespace ns="${namespace}";
(:: import schema at "../schema/${serviceName}.xsd" ::)

declare variable $reqMsg as element() external;
declare variable $originalMessage as element() external;

declare function local:func($reqMsg as element(), $originalMessage as element()) as element(ns:${responseElement}) {
  <ns:${responseElement}>
${simpleFields}
${groupFields ? "\n" + groupFields : ""}
${listFields ? "\n" + listFields : ""}
    <ns:TrackingId>{fn:data($originalMessage/ns:TrackingId)}</ns:TrackingId>
  </ns:${responseElement}>
};

local:func($reqMsg, $originalMessage)`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:xqueryEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:xquery><![CDATA[${xq}]]></con:xquery>
    <con:dependencies>
        <con:importSchema location="../schema/${serviceName}.xsd">
            <con:schema ref="${projectName}/schema/${serviceName}"/>
        </con:importSchema>
    </con:dependencies>
</con:xqueryEntry>`;
}

function generateRequestXQ_Siebel(config) {
  const { serviceName, namespace, requestElement, requestFields, projectName, siebelInputElement, siebelWsdlRef } = config;
  const siebelNs = "http://siebel.com/CustomUI";

  const simpleFields = requestFields.filter(f => !f.isList && !f.isGroup && f.siebelMapping).map(f => {
    return `        <ns2:${f.siebelMapping}>{fn:data($InputRequest/ns1:${f.name})}</ns2:${f.siebelMapping}>`;
  }).join("\n");

  const groupFields = requestFields.filter(f => f.isGroup && f.children?.length > 0).map(f => {
    if (f.siebelMapping) {
      const childMappings = f.children.filter(c => c.siebelMapping).map(c => {
        return `          <ns2:${c.siebelMapping}>{fn:data($InputRequest/ns1:${f.name}/ns1:${c.name})}</ns2:${c.siebelMapping}>`;
      }).join("\n");
      return `        <ns2:${f.siebelMapping}>\n${childMappings}\n        </ns2:${f.siebelMapping}>`;
    }
    return f.children.filter(c => c.siebelMapping).map(c => {
      return `        <ns2:${c.siebelMapping}>{fn:data($InputRequest/ns1:${f.name}/ns1:${c.name})}</ns2:${c.siebelMapping}>`;
    }).join("\n");
  }).join("\n");

  const listFields = requestFields.filter(f => f.isList && f.siebelMapping && f.children).map(f => {
    const childMappings = f.children.filter(c => c.siebelMapping).map(c => {
      return `              <ns2:${c.siebelMapping}>{fn:data($item/ns1:${c.name})}</ns2:${c.siebelMapping}>`;
    }).join("\n");
    return `        {
          for $item in $InputRequest/ns1:${f.name}
          return
            <ns2:${f.siebelMapping}>
${childMappings}
            </ns2:${f.siebelMapping}>
        }`;
  }).join("\n");

  const allMappings = [simpleFields, groupFields, listFields].filter(Boolean).join("\n");

  const xq = `xquery version "1.0" encoding "utf-8";

(:: OracleAnnotationVersion "1.0" ::)

declare namespace ns2="${siebelNs}";
(:: import schema at "../Resources/${siebelWsdlRef}.wsdl" ::)
declare namespace ns1="${namespace}";
(:: import schema at "../schema/${serviceName}.xsd" ::)

declare variable $InputRequest as element() (:: schema-element(ns1:${requestElement}) ::) external;

declare function local:func($InputRequest as element() (:: schema-element(ns1:${requestElement}) ::)) as element() (:: schema-element(ns2:${siebelInputElement}) ::) {
    <ns2:${siebelInputElement}>
${allMappings}
    </ns2:${siebelInputElement}>
};

local:func($InputRequest)`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:xqueryEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:xquery><![CDATA[${xq}]]></con:xquery>
    <con:dependencies>
        <con:importSchema location="../Resources/${siebelWsdlRef}.wsdl">
            <con:wsdl ref="${projectName}/Resources/${siebelWsdlRef}"/>
        </con:importSchema>
        <con:importSchema location="../schema/${serviceName}.xsd">
            <con:schema ref="${projectName}/schema/${serviceName}"/>
        </con:importSchema>
    </con:dependencies>
</con:xqueryEntry>`;
}

function generateResponseXQ_Siebel(config) {
  const { serviceName, namespace, responseElement, responseFields, projectName, siebelOutputElement, siebelWsdlRef } = config;
  const siebelNs = "http://siebel.com/CustomUI";

  const simpleFields = responseFields.filter(f => !f.isList && !f.isGroup && f.siebelMapping).map(f => {
    return `        <ns1:${f.name}>{fn:data($InputRequest/ns2:${f.siebelMapping})}</ns1:${f.name}>`;
  }).join("\n");

  const groupFields = responseFields.filter(f => f.isGroup && f.children?.length > 0).map(f => {
    if (f.siebelMapping) {
      const childMappings = f.children.filter(c => c.siebelMapping).map(c => {
        return `          <ns1:${c.name}>{fn:data($InputRequest/ns2:${f.siebelMapping}/ns2:${c.siebelMapping})}</ns1:${c.name}>`;
      }).join("\n");
      return `        <ns1:${f.name}>\n${childMappings}\n        </ns1:${f.name}>`;
    }
    const childMappings = f.children.filter(c => c.siebelMapping).map(c => {
      return `          <ns1:${c.name}>{fn:data($InputRequest/ns2:${c.siebelMapping})}</ns1:${c.name}>`;
    }).join("\n");
    return `        <ns1:${f.name}>\n${childMappings}\n        </ns1:${f.name}>`;
  }).join("\n");

  const listFields = responseFields.filter(f => f.isList && f.siebelMapping && f.children).map(f => {
    const childMappings = f.children.filter(c => c.siebelMapping).map(c => {
      return `              <ns1:${c.name}>{fn:data($item/ns2:${c.siebelMapping})}</ns1:${c.name}>`;
    }).join("\n");
    return `        {
          for $item in $InputRequest/ns2:${f.siebelMapping}
          return
            <ns1:${f.name}>
${childMappings}
            </ns1:${f.name}>
        }`;
  }).join("\n");

  const allMappings = [simpleFields, groupFields, listFields].filter(Boolean).join("\n");

  const xq = `xquery version "1.0" encoding "utf-8";

(:: OracleAnnotationVersion "1.0" ::)

declare namespace ns2="${siebelNs}";
(:: import schema at "../Resources/${siebelWsdlRef}.wsdl" ::)
declare namespace ns1="${namespace}";
(:: import schema at "../schema/${serviceName}.xsd" ::)

declare variable $InputRequest as element() (:: schema-element(ns2:${siebelOutputElement}) ::) external;
declare variable $originalMessage as element() external;

declare function local:func($InputRequest as element() (:: schema-element(ns2:${siebelOutputElement}) ::), $originalMessage as element()) as element() (:: schema-element(ns1:${responseElement}) ::) {
    <ns1:${responseElement}>
${allMappings}
        <ns1:TrackingId>{fn:data($originalMessage/ns1:TrackingId)}</ns1:TrackingId>
    </ns1:${responseElement}>
};

local:func($InputRequest, $originalMessage)`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:xqueryEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:xquery><![CDATA[${xq}]]></con:xquery>
    <con:dependencies>
        <con:importSchema location="../Resources/${siebelWsdlRef}.wsdl">
            <con:wsdl ref="${projectName}/Resources/${siebelWsdlRef}"/>
        </con:importSchema>
        <con:importSchema location="../schema/${serviceName}.xsd">
            <con:schema ref="${projectName}/schema/${serviceName}"/>
        </con:importSchema>
    </con:dependencies>
</con:xqueryEntry>`;
}

function generateODSPipeline(config) {
  const { serviceName, namespace, requestElement, responseElement, bindingName, projectName, operationName, odsServiceId } = config;
  const pipelineName = `${config.proxyName}Pipeline`;
  const odsNs = "http://ods.com/CustomUI";
  const siebelDbNs = "http://xmlns.oracle.com/pcbpel/adapter/db/sp/SiebelQueryDBBS";

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:pipelineEntry xmlns:con="http://www.bea.com/wli/sb/pipeline/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <con:coreEntry>
        <con:binding type="SOAP" isSoap12="false" xsi:type="con:SoapBindingType">
            <con:wsdl ref="${projectName}/wsdl/${serviceName}"/>
            <con:binding>
                <con:name>${bindingName}</con:name>
                <con:namespace>${namespace}</con:namespace>
            </con:binding>
        </con:binding>
        <con:xqConfiguration>
            <con:snippetVersion>1.0</con:snippetVersion>
        </con:xqConfiguration>
    </con:coreEntry>
    <con:router>
        <con:pipeline type="error" name="error-handler-${serviceName}">
            <con:stage id="${generateStageId()}" name="ErrorStage" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                <con:context>
                    <con1:userNsDecl prefix="ns" namespace="${odsNs}"/>
                    <con1:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config">
                        <con1:id>${generateId()}</con1:id>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()="SBL-100"</con:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id>${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText><![CDATA[<v1:${responseElement}>
    <v1:ErrorCode>{fn:data($output/ns:Error_spcCode)}</v1:ErrorCode>
    <v1:ErrorMessage>{fn:data($output/ns:Error_spcMessage)}</v1:ErrorMessage>
    <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
</v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()="SBL"</con:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id>${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>1</v1:ErrorCode>
        <v1:ErrorMessage>Siebel Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con1:xqueryText>$fault/ctx:errorCode/text()='SBLDB'</con1:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id>${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>500</v1:ErrorCode>
        <v1:ErrorMessage>Siebel DB Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{$originalMessage/v1:TrackingId}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:default>
                            <con2:replace varName="body" contents-only="true">
                                <con1:id>${generateId()}</con1:id>
                                <con2:expr>
                                    <con1:xqueryText><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>500</v1:ErrorCode>
        <v1:ErrorMessage>Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                </con2:expr>
                            </con2:replace>
                        </con2:default>
                    </con6:ifThenElse>
                    <con1:reply isError="false">
                        <con1:id>${generateId()}</con1:id>
                    </con1:reply>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:flow>
            <con:route-node name="RouteToODS" error-handler="error-handler-${serviceName}">
                <con:context>
                    <con1:userNsDecl prefix="ns" namespace="${odsNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                    <con1:userNsDecl prefix="sieb" namespace="${siebelDbNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                    <con1:varNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                </con:context>
                <con:actions>
                    <con1:route xmlns:con1="http://www.bea.com/wli/sb/stages/routing/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:service ref="CommonSBProject/proxy/LocalSiebelQueryToDBPS" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:operation>SiebelDBQuery</con1:operation>
                        <con1:outboundTransform>
                            <con3:assign varName="originalMessage" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con3:expr>
                                    <con1:xqueryText>$body/*</con1:xqueryText>
                                </con3:expr>
                            </con3:assign>
                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con4:logLevel>debug</con4:logLevel>
                                <con4:expr>
                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                </con4:expr>
                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|Input&gt;&gt;&gt;&gt;&gt;</con4:message>
                            </con4:log>
                            <con3:replace contents-only="true" varName="body" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con3:expr>
                                    <con1:xqueryTransform>
                                        <con1:resource ref="${projectName}/transformation/${serviceName}RequestXQ"/>
                                        <con1:param name="inputRequest">
                                            <con1:path>$originalMessage</con1:path>
                                        </con1:param>
                                    </con1:xqueryTransform>
                                </con3:expr>
                            </con3:replace>
                            <con6:replace varName="body" contents-only="true" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                                <con1:id>${generateId()}</con1:id>
                                <con2:expr>
                                    <con1:xqueryText><![CDATA[<sieb:InputParameters>
 <sieb:IP_SERVICE_ID>${odsServiceId}</sieb:IP_SERVICE_ID>
 <sieb:IP_INPUT_XML>{$body/*}</sieb:IP_INPUT_XML>
</sieb:InputParameters>]]></con1:xqueryText>
                                </con2:expr>
                            </con6:replace>
                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con4:logLevel>debug</con4:logLevel>
                                <con4:expr>
                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                </con4:expr>
                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|ODSInput&gt;&gt;&gt;&gt;&gt;</con4:message>
                            </con4:log>
                        </con1:outboundTransform>
                        <con1:responseTransform>
                            <con6:assign varName="DBOutput" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con2="http://www.bea.com/wli/sb/stages/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config">
                                <con2:id>${generateId()}</con2:id>
                                <con1:expr>
                                    <con2:xqueryText>$body/*</con2:xqueryText>
                                </con1:expr>
                            </con6:assign>
                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con4:logLevel>debug</con4:logLevel>
                                <con4:expr>
                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                </con4:expr>
                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|ODSOutput&gt;&gt;&gt;&gt;&gt;</con4:message>
                            </con4:log>
                            <con6:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con2="http://www.bea.com/wli/sb/stages/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config">
                                <con2:id>${generateId()}</con2:id>
                                <con1:case id="${generateId()}">
                                    <con1:condition>
                                        <con2:xqueryText>$body/sieb:OutputParameters/sieb:OP_ERROR/text()='DB Error'</con2:xqueryText>
                                    </con1:condition>
                                    <con1:actions>
                                        <con1:Error>
                                            <con2:id>${generateId()}</con2:id>
                                            <con1:errCode>SBLDB</con1:errCode>
                                        </con1:Error>
                                    </con1:actions>
                                </con1:case>
                                <con1:default>
                                    <con1:assign varName="output">
                                        <con2:id>${generateId()}</con2:id>
                                        <con1:expr>
                                            <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body/sieb:OutputParameters/sieb:OP_OUTPUT_XML/*</con:xqueryText>
                                        </con1:expr>
                                    </con1:assign>
                                </con1:default>
                            </con6:ifThenElse>
                            <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                                <con1:id>${generateId()}</con1:id>
                                <con2:case id="${generateId()}">
                                    <con2:condition>
                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$output/ns:Error_spcCode/text()='0'</con:xqueryText>
                                    </con2:condition>
                                    <con2:actions>
                                        <con2:replace varName="body" contents-only="true">
                                            <con1:id>${generateId()}</con1:id>
                                            <con2:expr>
                                                <con:xqueryTransform xmlns:con="http://www.bea.com/wli/sb/stages/config">
                                                    <con:resource ref="${projectName}/transformation/${serviceName}ResponseXQ"/>
                                                    <con:param name="reqMsg">
                                                        <con:path>$output</con:path>
                                                    </con:param>
                                                    <con:param name="originalMessage">
                                                        <con:path>$originalMessage</con:path>
                                                    </con:param>
                                                </con:xqueryTransform>
                                            </con2:expr>
                                        </con2:replace>
                                        <con5:log>
                                            <con1:id>${generateId()}</con1:id>
                                            <con5:logLevel>debug</con5:logLevel>
                                            <con5:expr>
                                                <con1:xqueryText>$body</con1:xqueryText>
                                            </con5:expr>
                                            <con5:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|Output&gt;&gt;&gt;&gt;&gt;</con5:message>
                                        </con5:log>
                                    </con2:actions>
                                </con2:case>
                                <con2:case id="${generateId()}">
                                    <con2:condition>
                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">(number($output/ns:Error_spcCode/text()) >= 100 
 and number($output/ns:Error_spcCode/text()) &lt;= 499)</con:xqueryText>
                                    </con2:condition>
                                    <con2:actions>
                                        <con2:Error>
                                            <con1:id>${generateId()}</con1:id>
                                            <con2:errCode>SBL-100</con2:errCode>
                                        </con2:Error>
                                    </con2:actions>
                                </con2:case>
                                <con2:default>
                                    <con2:Error>
                                        <con1:id>${generateId()}</con1:id>
                                        <con2:errCode>SBL</con2:errCode>
                                    </con2:Error>
                                </con2:default>
                            </con6:ifThenElse>
                        </con1:responseTransform>
                    </con1:route>
                </con:actions>
            </con:route-node>
        </con:flow>
    </con:router>
</con:pipelineEntry>`;
}

function generateSiebelPipeline(config) {
  const { serviceName, namespace, requestElement, responseElement, bindingName, projectName, operationName, siebelWsdlRef, siebelInputElement, siebelOutputElement } = config;
  const pipelineName = `${config.proxyName}Pipeline`;
  const siebelNs = "http://siebel.com/CustomUI";

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:pipelineEntry xmlns:con="http://www.bea.com/wli/sb/pipeline/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <con:coreEntry>
        <con:binding type="SOAP" isSoap12="false" xsi:type="con:SoapBindingType">
            <con:wsdl ref="${projectName}/wsdl/${serviceName}"/>
            <con:binding>
                <con:name>${bindingName}</con:name>
                <con:namespace>${namespace}</con:namespace>
            </con:binding>
        </con:binding>
        <con:xqConfiguration>
            <con:snippetVersion>1.0</con:snippetVersion>
        </con:xqConfiguration>
    </con:coreEntry>
    <con:router>
        <con:pipeline type="error" name="error-handler-${serviceName}">
            <con:stage id="${generateStageId()}" name="ErrorStage" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                <con:context>
                    <con1:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config">
                        <con1:id>${generateId()}</con1:id>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()="SBL-100"</con:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id>${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText><![CDATA[<v1:${responseElement}>
    <v1:ErrorCode>{fn:data($siebelOutput/*:Error_spcCode)}</v1:ErrorCode>
    <v1:ErrorMessage>{fn:data($siebelOutput/*:Error_spcMessage)}</v1:ErrorMessage>
    <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
</v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con1:xqueryText>$fault/ctx:errorCode/text()='SBL'</con1:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id>${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>1</v1:ErrorCode>
        <v1:ErrorMessage>Siebel Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:default>
                            <con2:replace varName="body" contents-only="true">
                                <con1:id>${generateId()}</con1:id>
                                <con2:expr>
                                    <con1:xqueryText><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>500</v1:ErrorCode>
        <v1:ErrorMessage>Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                </con2:expr>
                            </con2:replace>
                        </con2:default>
                    </con6:ifThenElse>
                    <con1:reply isError="false">
                        <con1:id>${generateId()}</con1:id>
                    </con1:reply>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:flow>
            <con:route-node name="RouteToSiebel" error-handler="error-handler-${serviceName}">
                <con:context>
                    <con1:userNsDecl prefix="ns2" namespace="${siebelNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                    <con1:varNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                </con:context>
                <con:actions>
                    <con1:route xmlns:con1="http://www.bea.com/wli/sb/stages/routing/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:service ref="${projectName}/business/${serviceName}BS" xsi:type="ref:BusinessServiceRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:operation>${siebelInputElement ? siebelInputElement.replace(/_Input$/, '') : operationName}</con1:operation>
                        <con1:outboundTransform>
                            <con3:assign varName="originalMessage" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con3:expr>
                                    <con1:xqueryText>$body/*</con1:xqueryText>
                                </con3:expr>
                            </con3:assign>
                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con4:logLevel>debug</con4:logLevel>
                                <con4:expr>
                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                </con4:expr>
                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|Input&gt;&gt;&gt;&gt;&gt;</con4:message>
                            </con4:log>
                            <con3:replace contents-only="true" varName="body" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con3:expr>
                                    <con1:xqueryTransform>
                                        <con1:resource ref="${projectName}/transformation/${serviceName}RequestXQ"/>
                                        <con1:param name="InputRequest">
                                            <con1:path>$originalMessage</con1:path>
                                        </con1:param>
                                    </con1:xqueryTransform>
                                </con3:expr>
                            </con3:replace>
                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con4:logLevel>debug</con4:logLevel>
                                <con4:expr>
                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                </con4:expr>
                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|SiebelInput&gt;&gt;&gt;&gt;&gt;</con4:message>
                            </con4:log>
                        </con1:outboundTransform>
                        <con1:responseTransform>
                            <con6:assign varName="siebelOutput" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con2="http://www.bea.com/wli/sb/stages/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config">
                                <con2:id>${generateId()}</con2:id>
                                <con1:expr>
                                    <con2:xqueryText>$body/*</con2:xqueryText>
                                </con1:expr>
                            </con6:assign>
                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                <con1:id>${generateId()}</con1:id>
                                <con4:logLevel>debug</con4:logLevel>
                                <con4:expr>
                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                </con4:expr>
                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|SiebelOutput&gt;&gt;&gt;&gt;&gt;</con4:message>
                            </con4:log>
                            <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                                <con1:id>${generateId()}</con1:id>
                                <con2:case id="${generateId()}">
                                    <con2:condition>
                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">fn:data($siebelOutput/*:Error_spcCode)='0'</con:xqueryText>
                                    </con2:condition>
                                    <con2:actions>
                                        <con2:replace varName="body" contents-only="true">
                                            <con1:id>${generateId()}</con1:id>
                                            <con2:expr>
                                                <con:xqueryTransform xmlns:con="http://www.bea.com/wli/sb/stages/config">
                                                    <con:resource ref="${projectName}/transformation/${serviceName}ResponseXQ"/>
                                                    <con:param name="InputRequest">
                                                        <con:path>$siebelOutput</con:path>
                                                    </con:param>
                                                    <con:param name="originalMessage">
                                                        <con:path>$originalMessage</con:path>
                                                    </con:param>
                                                </con:xqueryTransform>
                                            </con2:expr>
                                        </con2:replace>
                                        <con5:log>
                                            <con1:id>${generateId()}</con1:id>
                                            <con5:logLevel>debug</con5:logLevel>
                                            <con5:expr>
                                                <con1:xqueryText>$body</con1:xqueryText>
                                            </con5:expr>
                                            <con5:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${serviceName}|Output&gt;&gt;&gt;&gt;&gt;</con5:message>
                                        </con5:log>
                                    </con2:actions>
                                </con2:case>
                                <con2:case id="${generateId()}">
                                    <con2:condition>
                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">(number($siebelOutput/*:Error_spcCode/text()) >= 100
 and number($siebelOutput/*:Error_spcCode/text()) &lt;= 499)</con:xqueryText>
                                    </con2:condition>
                                    <con2:actions>
                                        <con2:Error>
                                            <con1:id>${generateId()}</con1:id>
                                            <con2:errCode>SBL-100</con2:errCode>
                                        </con2:Error>
                                    </con2:actions>
                                </con2:case>
                                <con2:default>
                                    <con2:Error>
                                        <con1:id>${generateId()}</con1:id>
                                        <con2:errCode>SBL</con2:errCode>
                                    </con2:Error>
                                </con2:default>
                            </con6:ifThenElse>
                        </con1:responseTransform>
                    </con1:route>
                </con:actions>
            </con:route-node>
        </con:flow>
    </con:router>
</con:pipelineEntry>`;
}

// ─── MULTI-OPERATION GENERATORS ─────────────────────────────

function generateMultiOpSchema(config, opConfigs, isDmz) {
  const { serviceName, namespace, dmzChannels } = config;

  // Build DMZ extra fields based on enabled channels
  const dmzExtraReqFields = [];
  if (isDmz) {
    const hasMobility = dmzChannels?.mobility ?? true;
    const hasB2B = dmzChannels?.b2b ?? false;
    const hasSSF = dmzChannels?.ssf ?? false;
    const seen = new Set();
    const add = (name) => { if (!seen.has(name)) { seen.add(name); dmzExtraReqFields.push(name); } };
    // Common across all flows
    add("EncPayload");
    add("UpdatedEncPayload");
    if (hasMobility) { add("LoginType"); add("ContactUCMId"); add("EmailId"); add("MobileNumber"); }
    if (hasB2B) { add("SubSource"); }
    if (hasSSF) { add("SSFPartnerLoginId"); add("Source"); }
  }
  const dmzExtraResFields = ["EncResponse"];

  const renderField = (f) => {
    if (f.isList && f.children && f.children.length > 0) {
      const childFields = f.children.map(c =>
        `              <xsd:element name="${c.name}" type="xsd:string" minOccurs="0"/>`
      ).join("\n");
      return `        <xsd:element name="${f.name}" minOccurs="0" maxOccurs="unbounded">
          <xsd:complexType>
            <xsd:sequence>
${childFields}
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>`;
    }
    if (f.isGroup && f.children && f.children.length > 0) {
      const childFields = f.children.map(c => renderField(c)).join("\n");
      return `        <xsd:element name="${f.name}" minOccurs="0">
          <xsd:complexType>
            <xsd:sequence>
${childFields}
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>`;
    }
    return `        <xsd:element name="${f.name}" type="xsd:${f.type || 'string'}" minOccurs="0"/>`;
  };

  const elements = opConfigs.map(op => {
    const reqFieldNames = new Set(op.requestFields.map(f => f.name));
    const resFieldNames = new Set(op.responseFields.map(f => f.name));
    const reqFields = op.requestFields.map(renderField).join("\n");
    const resFields = op.responseFields.map(renderField).join("\n");

    // Add DMZ extra fields that aren't already in user-defined fields
    const extraReq = isDmz ? dmzExtraReqFields
      .filter(name => !reqFieldNames.has(name))
      .map(name => `        <xsd:element name="${name}" type="xsd:string" minOccurs="0"/>`)
      .join("\n") : "";
    const extraRes = isDmz ? dmzExtraResFields
      .filter(name => !resFieldNames.has(name))
      .map(name => `        <xsd:element name="${name}" type="xsd:string" minOccurs="0"/>`)
      .join("\n") : "";

    return `
  <xsd:element name="${op.requestElement}">
    <xsd:complexType>
      <xsd:sequence>
${reqFields}${extraReq ? "\n" + extraReq : ""}
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>

  <xsd:element name="${op.responseElement}">
    <xsd:complexType>
      <xsd:sequence>
${resFields}${extraRes ? "\n" + extraRes : ""}
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>`;
  }).join("\n");

  const xsd = `<?xml version="1.0" encoding="windows-1252"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
            xmlns="${namespace}"
            targetNamespace="${namespace}"
            elementFormDefault="qualified">
${elements}

</xsd:schema>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:schemaEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:schema><![CDATA[${xsd}]]></con:schema>
    <con:targetNamespace>${namespace}</con:targetNamespace>
</con:schemaEntry>`;
}

function generateMultiOpWsdl(config, opConfigs) {
  const { serviceName, namespace, bindingName, portTypeName, projectName } = config;

  const messages = opConfigs.map(op => `    <wsdl:message name="${op.operationName}_inputMessage">
        <wsdl:part name="request" element="inp1:${op.requestElement}"/>
    </wsdl:message>
    <wsdl:message name="${op.operationName}_outputMessage">
        <wsdl:part name="reply" element="inp1:${op.responseElement}"/>
    </wsdl:message>`).join("\n");

  const portTypeOps = opConfigs.map(op => `        <wsdl:operation name="${op.operationName}">
            <wsdl:input message="tns:${op.operationName}_inputMessage"/>
            <wsdl:output message="tns:${op.operationName}_outputMessage"/>
        </wsdl:operation>`).join("\n");

  const bindingOps = opConfigs.map(op => `        <wsdl:operation name="${op.operationName}">
            <soap:operation soapAction="${op.operationName}"/>
            <wsdl:input>
                <soap:body use="literal"/>
            </wsdl:input>
            <wsdl:output>
                <soap:body use="literal"/>
            </wsdl:output>
        </wsdl:operation>`).join("\n");

  const wsdl = `<wsdl:definitions name="${serviceName}" targetNamespace="${namespace}" xmlns:tns="${namespace}" xmlns:inp1="${namespace}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
    <wsdl:types>
        <xsd:schema>
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
    </wsdl:types>
${messages}
    <wsdl:portType name="${portTypeName}">
${portTypeOps}
    </wsdl:portType>
    <wsdl:binding name="${bindingName}" type="tns:${portTypeName}">
        <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
${bindingOps}
    </wsdl:binding>
</wsdl:definitions>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wsdlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wsdl><![CDATA[${wsdl}]]></con:wsdl>
    <con:dependencies>
        <con:schemaRef isInclude="false" schemaLocation="../schema/${serviceName}.xsd" namespace="${namespace}" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
    <con:targetNamespace>${namespace}</con:targetNamespace>
</con:wsdlEntry>`;
}

function generateMultiOpWadl(config, opConfigs) {
  const { serviceName, namespace, proxyName, projectName } = config;

  const resources = opConfigs.map(op => `      <resource path="/${op.operationName}">
         <method name="POST" soa:wsdlOperation="${op.operationName}">
            <request>
               <representation mediaType="application/json" element="cns:${op.requestElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${op.requestElement}" xmlns:cns="${namespace}"/>
            </request>
            <response status="200">
               <representation mediaType="application/json" element="cns:${op.responseElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${op.responseElement}" xmlns:cns="${namespace}"/>
            </response>
         </method>
      </resource>`).join("\n");

  const wadl = `<application xmlns:soa="http://www.oracle.com/soa/rest" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="${namespace}" xmlns="http://wadl.dev.java.net/2009/02">
   <doc title="${proxyName}">RestService</doc>
   <grammars>
      <xsd:schema xmlns:inp1="${namespace}" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
   </grammars>
   <resources>
${resources}
   </resources>
</application>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wadlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wadl><![CDATA[${wadl}]]></con:wadl>
    <con:dependencies>
        <con:importSchema namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
</con:wadlEntry>`;
}

// Helper: generate ODS route-node actions XML for a single operation branch
function generateODSBranchRoute(opConfig) {
  const { projectName, namespace, responseElement, operationName } = opConfig;
  const odsNs = "http://ods.com/CustomUI";
  const siebelDbNs = "http://xmlns.oracle.com/pcbpel/adapter/db/sp/SiebelQueryDBBS";
  const odsServiceId = opConfig.odsServiceId;

  return `                                <con:context>
                                    <con1:userNsDecl prefix="ns" namespace="${odsNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                                    <con1:userNsDecl prefix="sieb" namespace="${siebelDbNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                                    <con1:varNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                                </con:context>
                                <con:actions>
                                    <con1:route xmlns:con1="http://www.bea.com/wli/sb/stages/routing/config">
                                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                                        <con1:service ref="CommonSBProject/proxy/LocalSiebelQueryToDBPS" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                        <con1:operation>SiebelDBQuery</con1:operation>
                                        <con1:outboundTransform>
                                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con1:id>${generateId()}</con1:id>
                                                <con4:logLevel>debug</con4:logLevel>
                                                <con4:expr>
                                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                                </con4:expr>
                                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${operationName}|ODSInput&gt;&gt;&gt;&gt;&gt;</con4:message>
                                            </con4:log>
                                        </con1:outboundTransform>
                                        <con1:responseTransform>
                                            <con6:assign varName="DBOutput" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con2="http://www.bea.com/wli/sb/stages/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config">
                                                <con2:id>${generateId()}</con2:id>
                                                <con1:expr>
                                                    <con2:xqueryText>$body/*</con2:xqueryText>
                                                </con1:expr>
                                            </con6:assign>
                                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con1:id>${generateId()}</con1:id>
                                                <con4:logLevel>debug</con4:logLevel>
                                                <con4:expr>
                                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                                </con4:expr>
                                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${operationName}|ODSOutput&gt;&gt;&gt;&gt;&gt;</con4:message>
                                            </con4:log>
                                            <con6:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con2="http://www.bea.com/wli/sb/stages/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config">
                                                <con2:id>${generateId()}</con2:id>
                                                <con1:case id="${generateId()}">
                                                    <con1:condition>
                                                        <con2:xqueryText>$body/sieb:OutputParameters/sieb:OP_ERROR/text()='DB Error'</con2:xqueryText>
                                                    </con1:condition>
                                                    <con1:actions>
                                                        <con1:Error>
                                                            <con2:id>${generateId()}</con2:id>
                                                            <con1:errCode>SBLDB</con1:errCode>
                                                        </con1:Error>
                                                    </con1:actions>
                                                </con1:case>
                                                <con1:default>
                                                    <con1:assign varName="output">
                                                        <con2:id>${generateId()}</con2:id>
                                                        <con1:expr>
                                                            <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body/sieb:OutputParameters/sieb:OP_OUTPUT_XML/*</con:xqueryText>
                                                        </con1:expr>
                                                    </con1:assign>
                                                </con1:default>
                                            </con6:ifThenElse>
                                            <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                                                <con1:id>${generateId()}</con1:id>
                                                <con2:case id="${generateId()}">
                                                    <con2:condition>
                                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$output/ns:Error_spcCode/text()='0'</con:xqueryText>
                                                    </con2:condition>
                                                    <con2:actions>
                                                        <con2:replace varName="body" contents-only="true">
                                                            <con1:id>${generateId()}</con1:id>
                                                            <con2:expr>
                                                                <con:xqueryTransform xmlns:con="http://www.bea.com/wli/sb/stages/config">
                                                                    <con:resource ref="${projectName}/transformation/${operationName}ResponseXQ"/>
                                                                    <con:param name="reqMsg">
                                                                        <con:path>$output</con:path>
                                                                    </con:param>
                                                                    <con:param name="originalMessage">
                                                                        <con:path>$originalMessage</con:path>
                                                                    </con:param>
                                                                </con:xqueryTransform>
                                                            </con2:expr>
                                                        </con2:replace>
                                                        <con5:log>
                                                            <con1:id>${generateId()}</con1:id>
                                                            <con5:logLevel>debug</con5:logLevel>
                                                            <con5:expr>
                                                                <con1:xqueryText>$body</con1:xqueryText>
                                                            </con5:expr>
                                                            <con5:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${operationName}|Output&gt;&gt;&gt;&gt;&gt;</con5:message>
                                                        </con5:log>
                                                    </con2:actions>
                                                </con2:case>
                                                <con2:case id="${generateId()}">
                                                    <con2:condition>
                                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">(number($output/ns:Error_spcCode/text()) >= 100
 and number($output/ns:Error_spcCode/text()) &lt;= 499)</con:xqueryText>
                                                    </con2:condition>
                                                    <con2:actions>
                                                        <con2:Error>
                                                            <con1:id>${generateId()}</con1:id>
                                                            <con2:errCode>SBL-100</con2:errCode>
                                                        </con2:Error>
                                                    </con2:actions>
                                                </con2:case>
                                                <con2:default>
                                                    <con2:Error>
                                                        <con1:id>${generateId()}</con1:id>
                                                        <con2:errCode>SBL</con2:errCode>
                                                    </con2:Error>
                                                </con2:default>
                                            </con6:ifThenElse>
                                        </con1:responseTransform>
                                    </con1:route>
                                </con:actions>`;
}

// Helper: generate Siebel route-node actions XML for a single operation branch
function generateSiebelBranchRoute(opConfig) {
  const { projectName, namespace, operationName, siebelInputElement } = opConfig;
  const siebelNs = "http://siebel.com/CustomUI";
  const bsName = `${operationName}BS`;

  return `                                <con:context>
                                    <con1:userNsDecl prefix="ns2" namespace="${siebelNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                                    <con1:varNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                                </con:context>
                                <con:actions>
                                    <con1:route xmlns:con1="http://www.bea.com/wli/sb/stages/routing/config">
                                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                                        <con1:service ref="${projectName}/business/${bsName}" xsi:type="ref:BusinessServiceRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                        <con1:operation>${siebelInputElement ? siebelInputElement.replace(/_Input$/, '') : operationName}</con1:operation>
                                        <con1:outboundTransform>
                                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con1:id>${generateId()}</con1:id>
                                                <con4:logLevel>debug</con4:logLevel>
                                                <con4:expr>
                                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                                </con4:expr>
                                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${operationName}|SiebelInput&gt;&gt;&gt;&gt;&gt;</con4:message>
                                            </con4:log>
                                        </con1:outboundTransform>
                                        <con1:responseTransform>
                                            <con6:assign varName="siebelOutput" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con2="http://www.bea.com/wli/sb/stages/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config">
                                                <con2:id>${generateId()}</con2:id>
                                                <con1:expr>
                                                    <con2:xqueryText>$body/*</con2:xqueryText>
                                                </con1:expr>
                                            </con6:assign>
                                            <con4:log xmlns:con4="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con1:id>${generateId()}</con1:id>
                                                <con4:logLevel>debug</con4:logLevel>
                                                <con4:expr>
                                                    <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$body</con:xqueryText>
                                                </con4:expr>
                                                <con4:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${operationName}|SiebelOutput&gt;&gt;&gt;&gt;&gt;</con4:message>
                                            </con4:log>
                                            <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                                                <con1:id>${generateId()}</con1:id>
                                                <con2:case id="${generateId()}">
                                                    <con2:condition>
                                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">fn:data($siebelOutput/*:Error_spcCode)='0'</con:xqueryText>
                                                    </con2:condition>
                                                    <con2:actions>
                                                        <con2:replace varName="body" contents-only="true">
                                                            <con1:id>${generateId()}</con1:id>
                                                            <con2:expr>
                                                                <con:xqueryTransform xmlns:con="http://www.bea.com/wli/sb/stages/config">
                                                                    <con:resource ref="${projectName}/transformation/${operationName}ResponseXQ"/>
                                                                    <con:param name="InputRequest">
                                                                        <con:path>$siebelOutput</con:path>
                                                                    </con:param>
                                                                    <con:param name="originalMessage">
                                                                        <con:path>$originalMessage</con:path>
                                                                    </con:param>
                                                                </con:xqueryTransform>
                                                            </con2:expr>
                                                        </con2:replace>
                                                        <con5:log>
                                                            <con1:id>${generateId()}</con1:id>
                                                            <con5:logLevel>debug</con5:logLevel>
                                                            <con5:expr>
                                                                <con1:xqueryText>$body</con1:xqueryText>
                                                            </con5:expr>
                                                            <con5:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${operationName}|Output&gt;&gt;&gt;&gt;&gt;</con5:message>
                                                        </con5:log>
                                                    </con2:actions>
                                                </con2:case>
                                                <con2:case id="${generateId()}">
                                                    <con2:condition>
                                                        <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">(number($siebelOutput/*:Error_spcCode/text()) >= 100
 and number($siebelOutput/*:Error_spcCode/text()) &lt;= 499)</con:xqueryText>
                                                    </con2:condition>
                                                    <con2:actions>
                                                        <con2:Error>
                                                            <con1:id>${generateId()}</con1:id>
                                                            <con2:errCode>SBL-100</con2:errCode>
                                                        </con2:Error>
                                                    </con2:actions>
                                                </con2:case>
                                                <con2:default>
                                                    <con2:Error>
                                                        <con1:id>${generateId()}</con1:id>
                                                        <con2:errCode>SBL</con2:errCode>
                                                    </con2:Error>
                                                </con2:default>
                                            </con6:ifThenElse>
                                        </con1:responseTransform>
                                    </con1:route>
                                </con:actions>`;
}

// Helper: generate ODS error handler pipeline content for a branch operation
function generateODSBranchErrorHandler(opConfig) {
  const { namespace, responseElement, projectName, operationName } = opConfig;
  const odsNs = "http://ods.com/CustomUI";

  return `                <con:context>
                    <con1:userNsDecl prefix="ns" namespace="${odsNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                    <con1:userNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                </con:context>
                <con:actions>
                    <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config">
                        <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()="SBL-100"</con:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
    <v1:ErrorCode>{fn:data($output/ns:Error_spcCode)}</v1:ErrorCode>
    <v1:ErrorMessage>{fn:data($output/ns:Error_spcMessage)}</v1:ErrorMessage>
    <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
</v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()="SBL"</con:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>1</v1:ErrorCode>
        <v1:ErrorMessage>Siebel Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()='SBLDB'</con1:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>500</v1:ErrorCode>
        <v1:ErrorMessage>Siebel DB Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{$originalMessage/v1:TrackingId}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:default>
                            <con2:replace varName="body" contents-only="true">
                                <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                <con2:expr>
                                    <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>500</v1:ErrorCode>
        <v1:ErrorMessage>Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                </con2:expr>
                            </con2:replace>
                        </con2:default>
                    </con6:ifThenElse>
                    <con1:reply isError="false" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                        <con1:id>${generateId()}</con1:id>
                    </con1:reply>
                </con:actions>`;
}

// Helper: generate Siebel error handler pipeline content for a branch operation
function generateSiebelBranchErrorHandler(opConfig) {
  const { namespace, responseElement, projectName, operationName } = opConfig;
  const siebelNs = "http://siebel.com/CustomUI";

  return `                <con:context>
                    <con1:userNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                    <con1:userNsDecl prefix="ns2" namespace="${siebelNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                </con:context>
                <con:actions>
                    <con6:ifThenElse xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config">
                        <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con:xqueryText xmlns:con="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()="SBL-100"</con:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
    <v1:ErrorCode>{fn:data($siebelOutput/*:Error_spcCode)}</v1:ErrorCode>
    <v1:ErrorMessage>{fn:data($siebelOutput/*:Error_spcMessage)}</v1:ErrorMessage>
    <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
</v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:case id="${generateId()}">
                            <con2:condition>
                                <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config">$fault/ctx:errorCode/text()='SBL'</con1:xqueryText>
                            </con2:condition>
                            <con2:actions>
                                <con2:replace varName="body" contents-only="true">
                                    <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                    <con2:expr>
                                        <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>1</v1:ErrorCode>
        <v1:ErrorMessage>Siebel Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                    </con2:expr>
                                </con2:replace>
                            </con2:actions>
                        </con2:case>
                        <con2:default>
                            <con2:replace varName="body" contents-only="true">
                                <con1:id xmlns:con1="http://www.bea.com/wli/sb/stages/config">${generateId()}</con1:id>
                                <con2:expr>
                                    <con1:xqueryText xmlns:con1="http://www.bea.com/wli/sb/stages/config"><![CDATA[<v1:${responseElement}>
        <v1:ErrorCode>500</v1:ErrorCode>
        <v1:ErrorMessage>Technical Error</v1:ErrorMessage>
        <v1:TrackingId>{fn:data($originalMessage/v1:TrackingId)}</v1:TrackingId>
  </v1:${responseElement}>]]></con1:xqueryText>
                                </con2:expr>
                            </con2:replace>
                        </con2:default>
                    </con6:ifThenElse>
                    <con1:reply isError="false" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                        <con1:id>${generateId()}</con1:id>
                    </con1:reply>
                </con:actions>`;
}

function generateMultiOpPipeline(config, opConfigs) {
  const { serviceName, namespace, bindingName, projectName, proxyName } = config;
  const odsNs = "http://ods.com/CustomUI";
  const siebelDbNs = "http://xmlns.oracle.com/pcbpel/adapter/db/sp/SiebelQueryDBBS";

  // Pre-generate pipeline IDs for each operation
  const opPipelines = opConfigs.map((op, idx) => ({
    reqId: `request-${generatePipelineId()}`,
    resId: `response-${generatePipelineId()}`,
    errId: `error-${generatePipelineId()}`,
    op,
    idx,
  }));

  // Global variable pipeline pair
  const globalReqId = `request-${generatePipelineId()}`;
  const globalResId = `response-${generatePipelineId()}`;

  // Build named request pipelines (per-op)
  const requestPipelines = opPipelines.map(({ reqId, op }) => {
    const isODS = op.serviceType === 'ODS';
    const xqRef = `${projectName}/transformation/${op.operationName}RequestXQ`;

    let requestActions = `                    <con1:assign varName="originalMessage" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:expr>
                            <con2:xqueryText xmlns:con2="http://www.bea.com/wli/sb/stages/config">$body/*</con2:xqueryText>
                        </con1:expr>
                    </con1:assign>
                    <con1:log xmlns:con1="http://www.bea.com/wli/sb/stages/logging/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:logLevel>debug</con1:logLevel>
                        <con1:expr>
                            <con2:xqueryText xmlns:con2="http://www.bea.com/wli/sb/stages/config">$body</con2:xqueryText>
                        </con1:expr>
                        <con1:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${op.operationName}|OriginalInput&gt;&gt;&gt;&gt;&gt;</con1:message>
                    </con1:log>
                    <con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:expr>
                            <con2:xqueryTransform xmlns:con2="http://www.bea.com/wli/sb/stages/config">
                                <con2:resource ref="${xqRef}"/>
                                <con2:param name="${isODS ? 'inputRequest' : 'InputRequest'}">
                                    <con2:path>$originalMessage</con2:path>
                                </con2:param>
                            </con2:xqueryTransform>
                        </con1:expr>
                    </con1:replace>`;

    // ODS: wrap in InputParameters after XQ transform
    if (isODS) {
      requestActions += `
                    <con6:replace varName="body" contents-only="true" xmlns:con4="http://www.bea.com/wli/sb/stages/publish/config" xmlns:con5="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con2="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/routing/config" xmlns:con6="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                        <con1:id>${generateId()}</con1:id>
                        <con2:expr>
                            <con1:xqueryText><![CDATA[<sieb:InputParameters>
 <sieb:IP_SERVICE_ID>${op.odsServiceId}</sieb:IP_SERVICE_ID>
 <sieb:IP_INPUT_XML>{$body/*}</sieb:IP_INPUT_XML>
</sieb:InputParameters>]]></con1:xqueryText>
                        </con2:expr>
                    </con6:replace>`;
    }

    requestActions += `
                    <con1:log xmlns:con1="http://www.bea.com/wli/sb/stages/logging/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:logLevel>debug</con1:logLevel>
                        <con1:expr>
                            <con2:xqueryText xmlns:con2="http://www.bea.com/wli/sb/stages/config">$body</con2:xqueryText>
                        </con1:expr>
                        <con1:message>&lt;&lt;&lt;&lt;&lt;${projectName}|${op.operationName}|${isODS ? 'ODS' : 'Siebel'}Input&gt;&gt;&gt;&gt;&gt;</con1:message>
                    </con1:log>`;

    const nsDecls = isODS
      ? `<con1:userNsDecl prefix="sieb" namespace="${siebelDbNs}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>
                    <con1:userNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>`
      : `<con1:varNsDecl prefix="v1" namespace="${namespace}" xmlns:con1="http://www.bea.com/wli/sb/stages/config"/>`;

    return `        <con:pipeline type="request" name="${reqId}">
            <con:stage id="${generateStageId()}" name="RequestStage_${op.operationName}">
                <con:context>
                    ${nsDecls}
                </con:context>
                <con:actions>
${requestActions}
                </con:actions>
            </con:stage>
        </con:pipeline>`;
  }).join("\n");

  // Build named response pipelines (per-op) — empty, response logic is in route-node responseTransform
  const responsePipelines = opPipelines.map(({ resId, op }) =>
    `        <con:pipeline type="response" name="${resId}"/>`
  ).join("\n");

  // Build error handler pipelines (per-op)
  const errorPipelines = opPipelines.map(({ errId, op }) => {
    const isODS = op.serviceType === 'ODS';
    const errorContent = isODS
      ? generateODSBranchErrorHandler(op)
      : generateSiebelBranchErrorHandler(op);

    return `        <con:pipeline type="error" name="${errId}">
            <con:stage id="${generateStageId()}" name="ErrorHandler_${op.operationName}">
${errorContent}
            </con:stage>
        </con:pipeline>`;
  }).join("\n");

  // Global variable declaration pipeline
  const globalReqPipeline = `        <con:pipeline type="request" name="${globalReqId}">
            <con:stage id="${generateStageId()}" name="GlobalVariableDeclarationStage">
                <con:context/>
                <con:actions>
                    <con1:assign varName="operationVar" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con2:id xmlns:con2="http://www.bea.com/wli/sb/stages/config">${generateId()}</con2:id>
                        <con1:expr>
                            <con2:xqueryText xmlns:con2="http://www.bea.com/wli/sb/stages/config">$inbound/ctx:service/ctx:operation/text()</con2:xqueryText>
                        </con1:expr>
                    </con1:assign>
                </con:actions>
            </con:stage>
        </con:pipeline>`;
  const globalResPipeline = `        <con:pipeline type="response" name="${globalResId}"/>`;

  // Build branches
  const branches = opPipelines.map(({ reqId, resId, errId, op, idx }) => {
    const isODS = op.serviceType === 'ODS';
    const routeActions = isODS
      ? generateODSBranchRoute(op)
      : generateSiebelBranchRoute(op);

    return `                    <con:branch name="${op.operationName}">
                        <con:operator>equals</con:operator>
                        <con:value/>
                        <con:flow>
                            <con:pipeline-node name="Pipeline Pair Node${idx + 1}">
                                <con:request>${reqId}</con:request>
                                <con:response>${resId}</con:response>
                            </con:pipeline-node>
                            <con:route-node name="RouteNode${idx + 1}" error-handler="${errId}">
${routeActions}
                            </con:route-node>
                        </con:flow>
                    </con:branch>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:pipelineEntry xmlns:con="http://www.bea.com/wli/sb/pipeline/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <con:coreEntry>
        <con:binding type="SOAP" isSoap12="false" xsi:type="con:SoapBindingType">
            <con:wsdl ref="${projectName}/wsdl/${serviceName}"/>
            <con:binding>
                <con:name>${bindingName}</con:name>
                <con:namespace>${namespace}</con:namespace>
            </con:binding>
        </con:binding>
        <con:xqConfiguration>
            <con:snippetVersion>1.0</con:snippetVersion>
        </con:xqConfiguration>
    </con:coreEntry>
    <con:router>
${requestPipelines}
${responsePipelines}
${errorPipelines}
${globalReqPipeline}
${globalResPipeline}
        <con:flow>
            <con:pipeline-node name="GlobalVariablePipelinePairNode">
                <con:request>${globalReqId}</con:request>
                <con:response>${globalResId}</con:response>
            </con:pipeline-node>
            <con:branch-node type="operation" id="${generateFlowId()}" name="BranchNode1">
                <con:context/>
                <con:branch-table>
${branches}
                    <con:default-branch>
                        <con:flow/>
                    </con:default-branch>
                </con:branch-table>
            </con:branch-node>
        </con:flow>
    </con:router>
</con:pipelineEntry>`;
}

function generateBusinessService(config) {
  const { serviceName, projectName, siebelWsdlRef, siebelPortName, siebelEndpointUrl } = config;
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<con:businessServiceEntry xmlns:con="http://xmlns.oracle.com/servicebus/business/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:oper="http://xmlns.oracle.com/servicebus/business/operations" xmlns:ser="http://www.bea.com/wli/sb/services" xmlns:tran="http://www.bea.com/wli/sb/transports" xmlns:env="http://www.bea.com/wli/config/env" xmlns:http="http://www.bea.com/wli/sb/transports/http">
    <con:coreEntry>
        <con1:binding type="SOAP" xsi:type="con:SoapBindingType" isSoap12="false" xmlns:con="http://www.bea.com/wli/sb/services/bindings/config" xmlns:con1="http://xmlns.oracle.com/servicebus/business/config">
            <con:wsdl ref="${projectName}/Resources/${siebelWsdlRef}"/>
            <con:port>
                <con:name>${siebelPortName || serviceName}</con:name>
                <con:namespace>http://siebel.com/CustomUI</con:namespace>
            </con:port>
            <con:WSI-compliant>false</con:WSI-compliant>
        </con1:binding>
        <oper:operations enabled="true">
            <oper:throttling/>
            <oper:resultCachingEnabled>true</oper:resultCachingEnabled>
        </oper:operations>
        <con:ws-policy>
            <ser:binding-mode>no-policies</ser:binding-mode>
        </con:ws-policy>
        <con:xqConfiguration>
            <ser:snippetVersion>1.0</ser:snippetVersion>
        </con:xqConfiguration>
    </con:coreEntry>
    <con:endpointConfig>
        <tran:provider-id>http</tran:provider-id>
        <tran:inbound>false</tran:inbound>
        <tran:URI>
            <env:value>${escXml(siebelEndpointUrl)}</env:value>
        </tran:URI>
        <tran:outbound-properties>
            <tran:load-balancing-algorithm>round-robin</tran:load-balancing-algorithm>
            <tran:retry-count>0</tran:retry-count>
            <tran:retry-interval>30</tran:retry-interval>
            <tran:retry-application-errors>false</tran:retry-application-errors>
        </tran:outbound-properties>
        <tran:provider-specific xsi:type="http:HttpEndPointConfiguration">
            <http:outbound-properties>
                <http:request-method>POST</http:request-method>
                <http:timeout>${TIMEOUT_CONFIG.appSiebelBS.readTimeout}</http:timeout>
                <http:connection-timeout>${TIMEOUT_CONFIG.appSiebelBS.connectionTimeout}</http:connection-timeout>
                <http:follow-redirects>false</http:follow-redirects>
                <http:chunked-streaming-mode>false</http:chunked-streaming-mode>
                <http:session-sctikiness enabled="false" session-id-name="JSESSIONID"/>
            </http:outbound-properties>
            <http:dispatch-policy>SBDefaultResponseWorkManager</http:dispatch-policy>
            <http:compression>
                <http:compression-support>false</http:compression-support>
            </http:compression>
        </tran:provider-specific>
    </con:endpointConfig>
</con:businessServiceEntry>`;
}

// ─── DMZ LAYER GENERATORS ────────────────────────────────────

function generateDmzPsWsdlFile(config, opConfigs) {
  const { projectName, serviceName, namespace } = config;
  const ops = opConfigs || [config];
  const psName = `${serviceName}PS`;
  const psNs = `http://xmlns.oracle.com/LoyaltyServicesAppDMZ/${projectName}/${psName}`;

  const messages = ops.map(op => `    <wsdl:message name="${op.operationName}_inputMessage">
        <wsdl:part name="request" element="inp1:${op.requestElement}"/>
    </wsdl:message>
    <wsdl:message name="${op.operationName}_outputMessage">
        <wsdl:part name="reply" element="inp1:${op.responseElement}"/>
    </wsdl:message>`).join("\n");

  const portTypeOps = ops.map(op => `        <wsdl:operation name="${op.operationName}">
            <wsdl:input message="tns:${op.operationName}_inputMessage"/>
            <wsdl:output message="tns:${op.operationName}_outputMessage"/>
        </wsdl:operation>`).join("\n");

  const bindingOps = ops.map(op => `        <wsdl:operation name="${op.operationName}">
            <soap:operation soapAction="${op.operationName}"/>
            <wsdl:input>
                <soap:body use="literal"/>
            </wsdl:input>
            <wsdl:output>
                <soap:body use="literal"/>
            </wsdl:output>
        </wsdl:operation>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wsdlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wsdl><![CDATA[<?xml version= '1.0' encoding= 'UTF-8' ?>
<wsdl:definitions
     name="${psName}"
     targetNamespace="${psNs}"
     xmlns:tns="${psNs}"
     xmlns:inp1="${namespace}"
     xmlns:plnk="http://docs.oasis-open.org/wsbpel/2.0/plnktype"
     xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
     xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    >
    <plnk:partnerLinkType name="${psName}">
        <plnk:role name="${psName}Provider" portType="tns:${psName}_ptt"/>
    </plnk:partnerLinkType>
    <wsdl:types>
        <xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
    </wsdl:types>
${messages}
    <wsdl:portType name="${psName}_ptt">
${portTypeOps}
    </wsdl:portType>
   <wsdl:binding name="${psName}_ptt-binding" type="tns:${psName}_ptt">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>

${bindingOps}

</wsdl:binding>
</wsdl:definitions>]]></con:wsdl>
    <con:dependencies>
        <con:schemaRef isInclude="false" schemaLocation="../schema/${serviceName}.xsd" namespace="${namespace}" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
    <con:targetNamespace>${psNs}</con:targetNamespace>
</con:wsdlEntry>`;
}

function generateDmzProxyService(config) {
  const { projectName, serviceName, operationName, namespace, bindingName } = config;
  const psName = `${serviceName}PS`;
  const psNs = `http://xmlns.oracle.com/LoyaltyServicesAppDMZ/${projectName}/${psName}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ser:proxyServiceEntry xmlns:ser="http://www.bea.com/wli/sb/services" xmlns:con="http://www.bea.com/wli/sb/services/security/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:oper="http://xmlns.oracle.com/servicebus/proxy/operations" xmlns:tran="http://www.bea.com/wli/sb/transports" xmlns:env="http://www.bea.com/wli/config/env">
    <ser:coreEntry>
        <ser:description>This service was created by the REST adapter</ser:description>
        <ser:security>
            <con:inboundWss processWssHeader="true"/>
        </ser:security>
        <ser:binding type="REST" xsi:type="con:RestBindingType" xmlns:con="http://www.bea.com/wli/sb/services/bindings/config">
            <con:wsdl ref="${projectName}/wsdl/${serviceName}"/>
            <con:binding>
                <con:name>${psName}_ptt-binding</con:name>
                <con:namespace>${psNs}</con:namespace>
            </con:binding>
            <con:wadl ref="${projectName}/Resources/${psName}"/>
        </ser:binding>
        <oper:operations enabled="true"/>
        <ser:ws-policy>
            <ser:binding-mode>owsm-policy-bindings</ser:binding-mode>
            <ser:owsm-policy-metadata>
                <orawsp:wsm-assembly xmlns:orawsp="http://schemas.oracle.com/ws/2006/01/policy">
                    <sca11:policySet name="policySet" appliesTo="PROXY-REST-SERVICE()" attachTo="PROXY-REST-SERVICE('.')" orawsp:highId="1" xml:id="PROXY-REST-SERVICE__PROXY-REST-SERVICE_____" xmlns:sca11="http://docs.oasis-open.org/ns/opencsa/sca/200912">
                        <wsp:PolicyReference DigestAlgorithm="http://www.w3.org/ns/ws-policy/Sha1Exc" URI="oracle/http_jwt_token_service_policy" orawsp:status="enabled" orawsp:id="1" xmlns:wsp="http://www.w3.org/ns/ws-policy"/>
                    </sca11:policySet>
                </orawsp:wsm-assembly>
            </ser:owsm-policy-metadata>
        </ser:ws-policy>
        <ser:invoke ref="${projectName}/proxy/${psName}Pipeline" xsi:type="con1:PipelineRef" xmlns:con1="http://www.bea.com/wli/sb/pipeline/config"/>
        <ser:xqConfiguration>
            <ser:snippetVersion>1.0</ser:snippetVersion>
        </ser:xqConfiguration>
    </ser:coreEntry>
    <ser:endpointConfig>
        <tran:provider-id>http</tran:provider-id>
        <tran:inbound>true</tran:inbound>
        <tran:URI>
            <env:value>/secured/${serviceName}Rest/${config.operationName || serviceName}</env:value>
        </tran:URI>
        <tran:inbound-properties/>
        <tran:provider-specific xsi:type="http:HttpEndPointConfiguration" xmlns:http="http://www.bea.com/wli/sb/transports/http">
            <http:inbound-properties/>
            <http:compression>
                <http:compression-support>false</http:compression-support>
            </http:compression>
        </tran:provider-specific>
    </ser:endpointConfig>
</ser:proxyServiceEntry>`;
}

function generateDmzBusinessService(config) {
  const { projectName, serviceName, namespace, requestElement, responseElement, dmzAppLayerUrl } = config;
  const bsName = `${serviceName}BS`;
  const bsNs = `http://xmlns.oracle.com/LoyaltyServicesAppDMZ/${projectName}/${bsName}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<con:businessServiceEntry xmlns:con="http://xmlns.oracle.com/servicebus/business/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:oper="http://xmlns.oracle.com/servicebus/business/operations" xmlns:ser="http://www.bea.com/wli/sb/services" xmlns:tran="http://www.bea.com/wli/sb/transports" xmlns:env="http://www.bea.com/wli/config/env" xmlns:http="http://www.bea.com/wli/sb/transports/http">
    <con:coreEntry>
        <con:description>This service was created by the REST adapter</con:description>
        <con1:binding type="REST" xsi:type="con:RestBindingType" xmlns:con="http://www.bea.com/wli/sb/services/bindings/config" xmlns:con1="http://xmlns.oracle.com/servicebus/business/config">
            <con:wsdl ref="${projectName}/Resources/${bsName}"/>
            <con:binding>
                <con:name>${bsName}_ptt-binding</con:name>
                <con:namespace>${bsNs}</con:namespace>
            </con:binding>
            <con:wadl ref="${projectName}/Resources/${bsName}"/>
        </con1:binding>
        <oper:operations enabled="true">
            <oper:throttling/>
            <oper:resultCachingEnabled>true</oper:resultCachingEnabled>
        </oper:operations>
        <con:ws-policy>
            <ser:binding-mode>no-policies</ser:binding-mode>
        </con:ws-policy>
        <con:xqConfiguration>
            <ser:snippetVersion>1.0</ser:snippetVersion>
        </con:xqConfiguration>
    </con:coreEntry>
    <con:endpointConfig>
        <tran:provider-id>http</tran:provider-id>
        <tran:inbound>false</tran:inbound>
        <tran:URI>
            <env:value>${dmzAppLayerUrl}</env:value>
        </tran:URI>
        <tran:outbound-properties>
            <tran:load-balancing-algorithm>round-robin</tran:load-balancing-algorithm>
            <tran:retry-count>0</tran:retry-count>
            <tran:retry-interval>30</tran:retry-interval>
            <tran:retry-application-errors>false</tran:retry-application-errors>
        </tran:outbound-properties>
        <tran:provider-specific xsi:type="http:HttpEndPointConfiguration">
            <http:outbound-properties>
                <http:timeout>${TIMEOUT_CONFIG.dmzBS.readTimeout}</http:timeout>
                <http:connection-timeout>${TIMEOUT_CONFIG.dmzBS.connectionTimeout}</http:connection-timeout>
                <http:outbound-authentication xsi:type="http:HttpBasicAuthenticationType"/>
                <http:service-account ref="CommonSBProject/serviceaccount/SecurityServiceAccount"/>
                <http:follow-redirects>false</http:follow-redirects>
                <http:chunked-streaming-mode>false</http:chunked-streaming-mode>
                <http:session-sctikiness enabled="false" session-id-name="JSESSIONID"/>
            </http:outbound-properties>
            <http:dispatch-policy>SBDefaultResponseWorkManager</http:dispatch-policy>
            <http:compression>
                <http:compression-support>false</http:compression-support>
            </http:compression>
        </tran:provider-specific>
    </con:endpointConfig>
</con:businessServiceEntry>`;
}

function generateDmzBsWsdl(config, opConfigs) {
  const { projectName, serviceName, namespace } = config;
  const ops = opConfigs || [config];
  const bsName = `${serviceName}BS`;
  const bsNs = `http://xmlns.oracle.com/LoyaltyServicesAppDMZ/${projectName}/${bsName}`;

  const messages = ops.map(op => `    <wsdl:message name="${op.operationName}_inputMessage">
        <wsdl:part name="request" element="inp1:${op.requestElement}"/>
    </wsdl:message>
    <wsdl:message name="${op.operationName}_outputMessage">
        <wsdl:part name="reply" element="inp1:${op.responseElement}"/>
    </wsdl:message>`).join("\n");

  const portTypeOps = ops.map(op => `        <wsdl:operation name="${op.operationName}">
            <wsdl:input message="tns:${op.operationName}_inputMessage"/>
            <wsdl:output message="tns:${op.operationName}_outputMessage"/>
        </wsdl:operation>`).join("\n");

  const bindingOps = ops.map(op => `        <wsdl:operation name="${op.operationName}">
            <soap:operation soapAction="${op.operationName}"/>
            <wsdl:input>
                <soap:body use="literal"/>
            </wsdl:input>
            <wsdl:output>
                <soap:body use="literal"/>
            </wsdl:output>
        </wsdl:operation>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wsdlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wsdl><![CDATA[<wsdl:definitions name="${bsName}" targetNamespace="${bsNs}" xmlns:tns="${bsNs}" xmlns:inp1="${namespace}" xmlns:plnk="http://docs.oasis-open.org/wsbpel/2.0/plnktype" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">
    <plnk:partnerLinkType name="${bsName}">
        <plnk:role name="${bsName}Provider" portType="tns:${bsName}_ptt"/>
    </plnk:partnerLinkType>
    <wsdl:types>
        <xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
    </wsdl:types>
${messages}
    <wsdl:portType name="${bsName}_ptt">
${portTypeOps}
    </wsdl:portType>
    <wsdl:binding name="${bsName}_ptt-binding" type="tns:${bsName}_ptt">
        <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
${bindingOps}
    </wsdl:binding>
</wsdl:definitions>]]></con:wsdl>
    <con:dependencies>
        <con:schemaRef isInclude="false" schemaLocation="../schema/${serviceName}.xsd" namespace="${namespace}" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
    <con:targetNamespace>${bsNs}</con:targetNamespace>
</con:wsdlEntry>`;
}

function generateDmzBsWadl(config, opConfigs) {
  const { projectName, serviceName, namespace } = config;
  const ops = opConfigs || [config];
  const bsName = `${serviceName}BS`;
  const resources = ops.map(op => `      <resource path="/${op.operationName}">
         <method name="POST" soa:wsdlOperation="${op.operationName}">
            <request>
               <representation mediaType="application/json" element="cns:${op.requestElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${op.requestElement}" xmlns:cns="${namespace}"/>
            </request>
            <response status="200">
               <representation mediaType="application/json" element="cns:${op.responseElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${op.responseElement}" xmlns:cns="${namespace}"/>
            </response>
         </method>
      </resource>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wadlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wadl><![CDATA[<?xml version = '1.0' encoding = 'UTF-8'?>
<application xmlns:soa="http://www.oracle.com/soa/rest" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns0="${namespace}" xmlns="http://wadl.dev.java.net/2009/02">
   <doc title="${bsName}">RestReference</doc>
   <grammars>
      <xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
   </grammars>
   <resources>
${resources}
   </resources>
</application>]]></con:wadl>
    <con:dependencies>
        <con:importSchema namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
</con:wadlEntry>`;
}

function generateDmzPsWadl(config, opConfigs) {
  const { projectName, serviceName, namespace } = config;
  const ops = opConfigs || [config];
  const psName = `${serviceName}PS`;
  const resources = ops.map(op => `      <resource path="/${op.operationName}">
         <method name="POST" soa:wsdlOperation="${op.operationName}">
            <request>
               <representation mediaType="application/json" element="cns:${op.requestElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${op.requestElement}" xmlns:cns="${namespace}"/>
            </request>
            <response status="200">
               <representation mediaType="application/json" element="cns:${op.responseElement}" xmlns:cns="${namespace}"/>
               <representation mediaType="application/xml" element="cns:${op.responseElement}" xmlns:cns="${namespace}"/>
            </response>
         </method>
      </resource>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<con:wadlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wadl><![CDATA[<?xml version = '1.0' encoding = 'UTF-8'?>
<application xmlns:soa="http://www.oracle.com/soa/rest" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns0="${namespace}" xmlns="http://wadl.dev.java.net/2009/02">
   <doc title="${psName}">RestService</doc>
   <grammars>
      <xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
            <xsd:import namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd"/>
        </xsd:schema>
   </grammars>
   <resources>
${resources}
   </resources>
</application>]]></con:wadl>
    <con:dependencies>
        <con:importSchema namespace="${namespace}" schemaLocation="../schema/${serviceName}.xsd" ref="${projectName}/schema/${serviceName}"/>
    </con:dependencies>
</con:wadlEntry>`;
}

function generateNxsdSchema(config, opConfigs) {
  const { serviceName, namespace, dmzChannels } = config;
  const ops = opConfigs || [config];

  const hasMobility = dmzChannels?.mobility ?? true;
  const hasB2B = dmzChannels?.b2b ?? false;
  const hasSSF = dmzChannels?.ssf ?? false;

  // Build DMZ extra request fields based on enabled channels
  const dmzExtraReqFields = [];
  const seen = new Set();
  const addField = (name, optional = true) => {
    if (!seen.has(name)) { seen.add(name); dmzExtraReqFields.push({ name, optional }); }
  };
  // Common across all flows
  addField("EncPayload");
  addField("UpdatedEncPayload");
  // Mobility extras
  if (hasMobility) {
    addField("LoginType");
    addField("ContactUCMId");
    addField("EmailId");
    addField("MobileNumber");
  }
  // B2B extras
  if (hasB2B) {
    addField("SubSource");
  }
  // SSF extras
  if (hasSSF) {
    addField("SSFPartnerLoginId");
    addField("Source");
  }

  const dmzExtraResFields = [
    { name: "EncResponse", optional: true },
  ];

  const renderField = (f) => {
    if (f.isList && f.children && f.children.length > 0) {
      const childFields = f.children.map(c =>
        `              <xsd:element name="${c.name}" type="xsd:string"/>`
      ).join("\n");
      return `        <xsd:element name="${f.name}" minOccurs="0" maxOccurs="unbounded">
          <xsd:complexType>
            <xsd:sequence>
${childFields}
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>`;
    }
    if (f.isGroup && f.children && f.children.length > 0) {
      const childFields = f.children.map(c => renderField(c)).join("\n");
      const minOcc = f.optional ? ' minOccurs="0"' : "";
      return `        <xsd:element name="${f.name}"${minOcc}>
          <xsd:complexType>
            <xsd:sequence>
${childFields}
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>`;
    }
    const minOcc = f.optional ? ' minOccurs="0"' : "";
    return `        <xsd:element name="${f.name}" type="xsd:string"${minOcc}/>`;
  };

  // Build request/response elements for each operation
  const buildReqLines = (requestFields) => {
    const reqFieldNames = new Set(requestFields.map(f => f.name));
    const reqLines = [];
    const trackingField = requestFields.find(f => f.name === "TrackingId");
    if (trackingField) reqLines.push(renderField(trackingField));
    for (const ef of dmzExtraReqFields) {
      if (!reqFieldNames.has(ef.name)) {
        reqLines.push(`        <xsd:element name="${ef.name}" type="xsd:string" minOccurs="0"/>`);
      }
    }
    for (const f of requestFields) {
      if (f.name === "TrackingId") continue;
      reqLines.push(renderField(f));
    }
    return reqLines;
  };

  const buildResLines = (responseFields) => {
    const resLines = [];
    const ecField = responseFields.find(f => f.name === "ErrorCode");
    const emField = responseFields.find(f => f.name === "ErrorMessage");
    if (ecField) resLines.push(renderField(ecField));
    if (emField) resLines.push(renderField(emField));
    resLines.push(`        <xsd:element name="EncResponse" type="xsd:string" minOccurs="0"/>`);
    for (const f of responseFields) {
      if (f.name === "ErrorCode" || f.name === "ErrorMessage") continue;
      resLines.push(renderField(f));
    }
    return resLines;
  };

  // Generate element blocks for all operations
  const elementBlocks = ops.map(op => {
    const reqLines = buildReqLines(op.requestFields);
    const resLines = buildResLines(op.responseFields);
    return `
  <!-- ${op.operationName} Request Element -->
  <xsd:element name="${op.requestElement}">
    <xsd:complexType>
      <xsd:sequence>
${reqLines.join("\n")}
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>

  <!-- ${op.operationName} Response Element -->
  <xsd:element name="${op.responseElement}">
    <xsd:complexType>
      <xsd:sequence>
${resLines.join("\n")}
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<con:schemaEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:schema><![CDATA[<?xml version = '1.0' encoding = 'UTF-8'?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="${namespace}" targetNamespace="${namespace}" elementFormDefault="qualified" xmlns:nxsd="http://xmlns.oracle.com/pcbpel/nxsd" nxsd:version="JSON" nxsd:encoding="US-ASCII">
${elementBlocks}

  <xsd:annotation xmlns="">
      <xsd:appinfo>NXSDSAMPLE=</xsd:appinfo>
      <xsd:appinfo>USEHEADER=false</xsd:appinfo>
  </xsd:annotation>
</xsd:schema>]]></con:schema>
    <con:targetNamespace>${namespace}</con:targetNamespace>
    <con:nxsdVersion>JSON</con:nxsdVersion>
</con:schemaEntry>`;
}

function generateDmzPipeline(config, opConfigs) {
  const { projectName, serviceName, namespace, bindingName, dmzDvmKey, dmzNxsdName, dmzChannels } = config;
  const ops = opConfigs || [config];
  const { operationName, requestElement, responseElement } = ops[0];
  const bsName = `${serviceName}BS`;
  const psName = `${serviceName}PS`;
  const psNs = `http://xmlns.oracle.com/LoyaltyServicesAppDMZ/${projectName}/${psName}`;
  const nxsdRef = `${projectName}/schema/${dmzNxsdName}`;
  const bsRef = `${projectName}/business/${bsName}`;
  const id = generateId;
  const sid = generateStageId;

  // Generate pipeline names
  const pn = (suffix) => `pipeline-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
  const reqGlobal = pn("reqGlobal");
  const resGlobal = pn("resGlobal");

  // Derived channel flags
  const hasMobility = dmzChannels?.mobility ?? true;
  const hasB2B = dmzChannels?.b2b ?? false;
  const hasSSF = dmzChannels?.ssf ?? false;
  const channelCount = [hasMobility, hasB2B, hasSSF].filter(Boolean).length;
  const multiChannel = channelCount > 1;

  // Helper: md5 key derivation (no opBranch — stays in outer scope)
  const md5Key = (dvmKeyExpr) => `
                                <con1:javaCallout varName="key" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                                    <con1:className>cryptlib.CryptLib</con1:className>
                                    <con1:method>public static final java.lang.String md5(java.lang.String)</con1:method>
                                    <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/AESKeys.dvm","service",${dvmKeyExpr},"Key","")</con3:xqueryText></con1:expr>
                                    <con1:return-param-as-ref>false</con1:return-param-as-ref>
                                </con1:javaCallout>`;

  // ValidateTokenOAMCallStage (Mobility) — no opBranch
  const oamStage = (ehRef, reqEl) => `
            <con:stage name="ValidateTokenOAMCallStage" errorHandler="${ehRef}" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition>
                                <con3:xqueryText>($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='Mail') or ($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='mail')</con3:xqueryText>
                            </con1:condition>
                            <con1:actions>
                                <con1:wsCallout>
                                    <con3:id>${id()}</con3:id>
                                    <con1:service ref="OAMConsumerUserProfileSBProject/proxy/ConsumerUserProfileMailLocalPS" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                    <con1:request><con1:payload wrapped="false">Req</con1:payload></con1:request>
                                    <con1:response><con1:payload wrapped="false">Res</con1:payload></con1:response>
                                    <con1:requestTransform>
                                        <con1:transport-headers copy-all="false">
                                            <con3:id>${id()}</con3:id>
                                            <con1:header-set>outbound-request</con1:header-set>
                                            <con1:header name="Authorization" value="expression"><con3:xqueryText>$headerAuthorizationValue</con3:xqueryText></con1:header>
                                        </con1:transport-headers>
                                    </con1:requestTransform>
                                    <con1:responseTransform>
                                        <con1:ifThenElse>
                                            <con3:id>${id()}</con3:id>
                                            <con1:case id="${id()}">
                                                <con1:condition><con3:xqueryText>$Res//*:uid/text() !=" "</con3:xqueryText></con1:condition>
                                                <con1:actions/>
                                            </con1:case>
                                            <con1:default>
                                                <con1:Error><con3:id>${id()}</con3:id><con1:errCode>IDAM-Error</con1:errCode><con1:message>IDAM Validation Failed</con1:message></con1:Error>
                                            </con1:default>
                                        </con1:ifThenElse>
                                    </con1:responseTransform>
                                </con1:wsCallout>
                            </con1:actions>
                        </con1:case>
                        <con1:case id="${id()}">
                            <con1:condition>
                                <con3:xqueryText>($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='Mobile') or ($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='mobile')</con3:xqueryText>
                            </con1:condition>
                            <con1:actions>
                                <con1:wsCallout>
                                    <con3:id>${id()}</con3:id>
                                    <con1:service ref="OAMConsumerUserProfileSBProject/proxy/ConsumerUserProfileMobileLocalPS" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                    <con1:request><con1:payload wrapped="false">Req</con1:payload></con1:request>
                                    <con1:response><con1:payload wrapped="false">Res</con1:payload></con1:response>
                                    <con1:requestTransform>
                                        <con1:transport-headers copy-all="false">
                                            <con3:id>${id()}</con3:id>
                                            <con1:header-set>outbound-request</con1:header-set>
                                            <con1:header name="Authorization" value="expression"><con3:xqueryText>$headerAuthorizationValue</con3:xqueryText></con1:header>
                                        </con1:transport-headers>
                                    </con1:requestTransform>
                                    <con1:responseTransform>
                                        <con1:ifThenElse>
                                            <con3:id>${id()}</con3:id>
                                            <con1:case id="${id()}">
                                                <con1:condition><con3:xqueryText>$Res//*:uid/text() !=" "</con3:xqueryText></con1:condition>
                                                <con1:actions/>
                                            </con1:case>
                                            <con1:default>
                                                <con1:Error><con3:id>${id()}</con3:id><con1:errCode>IDAM-Error</con1:errCode><con1:message>IDAM Validation Failed</con1:message></con1:Error>
                                            </con1:default>
                                        </con1:ifThenElse>
                                    </con1:responseTransform>
                                </con1:wsCallout>
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            <con1:Error><con3:id>${id()}</con3:id><con1:errCode>LoginType01</con1:errCode><con1:message>LoginType is null or invalid</con1:message></con1:Error>
                        </con1:default>
                    </con1:ifThenElse>
                </con:actions>
            </con:stage>`;

  // ConsumerProfileServiceCallStage — no opBranch
  const consumerProfileStage = (ehRef, isAfterLogin, reqEl) => `
            <con:stage name="ConsumerProfileServiceCallStage" errorHandler="${ehRef}" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition>
                                <con3:xqueryText>($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='Mobile') or ($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='mobile')</con3:xqueryText>
                            </con1:condition>
                            <con1:actions>
                                <con1:ifThenElse>
                                    <con3:id>${id()}</con3:id>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>fn:exists($Res//*:mobile) and fn:string-length($Res//*:mobile/text()) > 0</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            <con1:ifThenElse>
                                                <con3:id>${id()}</con3:id>
                                                <con1:case id="${id()}">
                                                    <con1:condition><con3:xqueryText>$OriginalMessage/v1:${reqEl}/v1:MobileNumber/text() = $Res//*:mobile/text()</con3:xqueryText></con1:condition>
                                                    <con1:actions/>
                                                </con1:case>
                                                <con1:default>
                                                    <con1:Error><con3:id>${id()}</con3:id><con1:errCode>InvalidMobileNumber01</con1:errCode><con1:message>Mobile number does not match</con1:message></con1:Error>
                                                </con1:default>
                                            </con1:ifThenElse>
                                        </con1:actions>
                                    </con1:case>
                                    <con1:default>
                                        <con1:Error><con3:id>${id()}</con3:id><con1:errCode>NullMobileNumber001</con1:errCode><con1:message>Mobile number is null in OAM response</con1:message></con1:Error>
                                    </con1:default>
                                </con1:ifThenElse>
                            </con1:actions>
                        </con1:case>
                        <con1:case id="${id()}">
                            <con1:condition>
                                <con3:xqueryText>($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='Mail') or ($OriginalMessage/v1:${reqEl}/v1:LoginType/text()='mail')</con3:xqueryText>
                            </con1:condition>
                            <con1:actions>
                                <con1:ifThenElse>
                                    <con3:id>${id()}</con3:id>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>fn:exists($Res//*:mail) and fn:string-length($Res//*:mail/text()) > 0</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            <con1:ifThenElse>
                                                <con3:id>${id()}</con3:id>
                                                <con1:case id="${id()}">
                                                    <con1:condition><con3:xqueryText>$OriginalMessage/v1:${reqEl}/v1:EmailId/text() = $Res//*:mail/text()</con3:xqueryText></con1:condition>
                                                    <con1:actions/>
                                                </con1:case>
                                                <con1:default>
                                                    <con1:Error><con3:id>${id()}</con3:id><con1:errCode>InvalidEmailId01</con1:errCode><con1:message>Email ID does not match</con1:message></con1:Error>
                                                </con1:default>
                                            </con1:ifThenElse>
                                        </con1:actions>
                                    </con1:case>
                                    <con1:default>
                                        <con1:Error><con3:id>${id()}</con3:id><con1:errCode>NullEmailId001</con1:errCode><con1:message>Email ID is null in OAM response</con1:message></con1:Error>
                                    </con1:default>
                                </con1:ifThenElse>
                            </con1:actions>
                        </con1:case>
                        <con1:default/>
                    </con1:ifThenElse>${isAfterLogin ? `
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>fn:exists($Res//*:ucmid) and fn:string-length($Res//*:ucmid/text()) > 0</con3:xqueryText></con1:condition>
                            <con1:actions>
                                <con1:ifThenElse>
                                    <con3:id>${id()}</con3:id>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>$OriginalMessage/v1:${reqEl}/v1:ContactUCMId/text() = $Res//*:ucmid/text()</con3:xqueryText></con1:condition>
                                        <con1:actions/>
                                    </con1:case>
                                    <con1:default>
                                        <con1:Error><con3:id>${id()}</con3:id><con1:errCode>InvalidContactId01</con1:errCode><con1:message>ContactUCMId does not match</con1:message></con1:Error>
                                    </con1:default>
                                </con1:ifThenElse>
                            </con1:actions>
                        </con1:case>
                        <con1:default/>
                    </con1:ifThenElse>` : ""}
                </con:actions>
            </con:stage>`;

  // DeletionExtraElementsStage — no opBranch
  const deletionStage = (reqEl) => `
            <con:stage name="DeletionExtraElementsStage" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config">
                <con:context>
                    <con1:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con3:delete varName="body">
                        <con1:id>${id()}</con1:id>
                        <con3:location>
                            <con1:xpathText>.//v1:${reqEl}/v1:LoginType,
.//v1:${reqEl}/v1:ContactUCMId,
.//v1:${reqEl}/v1:EmailId,
.//v1:${reqEl}/v1:MobileNumber</con1:xpathText>
                        </con3:location>
                    </con3:delete>
                </con:actions>
            </con:stage>`;

  // SSF helper: md5 key derivation using SSFAESKeys.dvm (no opBranch)
  const ssfMd5Key = (dvmKeyExpr) => `
                                <con1:javaCallout varName="key" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                                    <con1:className>cryptlib.CryptLib</con1:className>
                                    <con1:method>public static final java.lang.String md5(java.lang.String)</con1:method>
                                    <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/SSFAESKeys.dvm","service",${dvmKeyExpr},"Key","")</con3:xqueryText></con1:expr>
                                    <con1:return-param-as-ref>false</con1:return-param-as-ref>
                                </con1:javaCallout>`;

  // ─── PER-OPERATION PIPELINE GENERATOR ───────────────────────────
  const generatePerOpPipelines = (op) => {
    // Shadow opBranch — single-op passthrough (no ifThenElse wrapping)
    const opBranch = (fn) => fn(op);

    // SSF DVM key: hardcoded per-operation (no runtime $operationVar lookup)
    const ssfDvmKeyExpr = `"SSF_${op.operationName}"`;

    // Per-op pipeline names
    const reqDecMob = pn(`reqDecMob_${op.operationName}`);
    const resEncMob = pn(`resEncMob_${op.operationName}`);
    const reqContactVal = pn(`reqContactVal_${op.operationName}`);
    const resContactVal = pn(`resContactVal_${op.operationName}`);
    const reqAfterLogin = pn(`reqAfterLogin_${op.operationName}`);
    const resAfterLogin = pn(`resAfterLogin_${op.operationName}`);
    const reqBeforeLogin = pn(`reqBeforeLogin_${op.operationName}`);
    const resBeforeLogin = pn(`resBeforeLogin_${op.operationName}`);
    const reqSSFDec = pn(`reqSSFDec_${op.operationName}`);
    const resSSFEnc = pn(`resSSFEnc_${op.operationName}`);
    const reqSSFOam = pn(`reqSSFOam_${op.operationName}`);
    const resSSFOam = pn(`resSSFOam_${op.operationName}`);
    const reqSSFPartner = pn(`reqSSFPartner_${op.operationName}`);
    const resSSFPartner = pn(`resSSFPartner_${op.operationName}`);
    const reqB2BAccess = pn(`reqB2BAccess_${op.operationName}`);
    const resB2BEnc = pn(`resB2BEnc_${op.operationName}`);
    const reqB2BOam = pn(`reqB2BOam_${op.operationName}`);
    const resB2BOam = pn(`resB2BOam_${op.operationName}`);

    // Helper: encryption block — uses local opBranch (single-op passthrough)
    const encryptBlock = (dvmKeyExpr, sourceExpr) => `
                                    ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:type>XML-To-Native</con1:type>
                                        <con1:sourceExpr>
                                            <con3:xqueryText>${sourceExpr}</con3:xqueryText>
                                        </con1:sourceExpr>
                                        <con1:nxsd ref="${nxsdRef}"/>
                                        <con1:schemaElement xmlns:ser="http://TargetNamespace.com/ServiceName">ser:${op.responseElement}</con1:schemaElement>
                                        <con1:replace-body-content/>
                                        <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                                    </con1:nxsdTranslation>`)}
                                    <con1:wsCallout xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:service ref="CommonSBProject/proxy/BinaryText" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                        <con1:request><con1:payload wrapped="true">body</con1:payload></con1:request>
                                        <con1:response><con1:payload wrapped="true">body</con1:payload></con1:response>
                                        <con1:requestTransform/>
                                        <con1:responseTransform/>
                                    </con1:wsCallout>
                                    <con1:javaCallout varName="EncResponse" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                                        <con1:className>cryptlib.CryptLib</con1:className>
                                        <con1:method>public static java.lang.String encrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                                        <con1:expr><con3:xqueryText>fn:data($body)</con3:xqueryText></con1:expr>
                                        <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                                        <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/AESKeys.dvm","service",${dvmKeyExpr},"IV","")</con3:xqueryText></con1:expr>
                                        <con1:return-param-as-ref>false</con1:return-param-as-ref>
                                    </con1:javaCallout>`;

    // Helper: final encrypted response replace + reply — uses local opBranch
    const encReplaceReply = (includeSubCode) => `
                                    ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:expr>
                                            <con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>{$errCode}</ErrorCode>${includeSubCode ? "\n<ErrorSubCode>{$errCode}</ErrorSubCode>" : ""}
<ErrorMessage>{$errMsg}</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText>
                                        </con1:expr>
                                    </con1:replace>`)}
                                    <con3:reply isError="false">
                                        <con3:id>${id()}</con3:id>
                                    </con3:reply>`;

    // Helper: error handler that encrypts error and replies — uses local opBranch
    const errorHandler = (stageName, dvmKeyExpr, includeSubCode) => {
      const ehName = `error-${stageName}-${Math.random().toString(36).slice(2, 10)}`;
      return { name: ehName, xml: `
        <con:pipeline name="${ehName}" type="error" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
            <con:stage name="${stageName}_EH" id="${sid()}">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con2:log>
                        <con3:id>${id()}</con3:id>
                        <con2:logLevel>debug</con2:logLevel>
                        <con2:expr><con3:xqueryText>$fault</con3:xqueryText></con2:expr>
                        <con2:message><![CDATA[<<<<<<${projectName}|${stageName}|FaultMessage>>>>>>>]]></con2:message>
                    </con2:log>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition>
                                <con3:xqueryText>$fault/ctx:errorCode = 'OSB-382500'</con3:xqueryText>
                            </con1:condition>
                            <con1:actions>
                                <con1:assign varName="errCode"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>"401"</con3:xqueryText></con1:expr></con1:assign>
                                <con1:assign varName="errMsg"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>"Unauthorized"</con3:xqueryText></con1:expr></con1:assign>
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            <con1:assign varName="errCode"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>"500"</con3:xqueryText></con1:expr></con1:assign>
                            <con1:assign varName="errMsg"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>"Technical Error"</con3:xqueryText></con1:expr></con1:assign>
                        </con1:default>
                    </con1:ifThenElse>
                    ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr>
                            <con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>{$errCode}</v1:ErrorCode>
<v1:TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</v1:TrackingId>
<v1:ErrorMessage>{$errMsg}</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText>
                        </con1:expr>
                    </con1:replace>`)}
                    ${md5Key(dvmKeyExpr)}
                    ${encryptBlock(dvmKeyExpr, "$body/*")}
                    ${encReplaceReply(includeSubCode)}
                </con:actions>
            </con:stage>
        </con:pipeline>` };
    };

    // SSF error handler — uses local opBranch
    // encrypt=true adds second stage with Flag='Y' encryption (for Partner)
    // encrypt=false adds reply directly in Stage 1 (for OAM)
    const ssfErrorHandler = (stageName, cases, encrypt = false, defaults = { code: "500", msgExpr: '"Technical Error"' }) => {
      const ehName = `error-${stageName}-${Math.random().toString(36).slice(2, 10)}`;

      const encryptionStage = encrypt ? `
            <con:stage name="Encryption${stageName}_EH" id="${sid()}" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>$Flag='Y'</con3:xqueryText></con1:condition>
                            <con1:actions>
                                <con1:assign varName="output">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText>$body/*</con3:xqueryText></con1:expr>
                                </con1:assign>
                                ${ssfEncryptBlock(ssfDvmKeyExpr, "$output")}
                                ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>{$output/*:ErrorCode/text()}</ErrorCode>
<ErrorSubCode>{$output/*:ErrorSubCode/text()}</ErrorSubCode>
<ErrorMessage>{$output/*:ErrorMessage/text()}</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                </con1:replace>`)}
                                <con2:log>
                                    <con3:id>${id()}</con3:id>
                                    <con2:logLevel>debug</con2:logLevel>
                                    <con2:expr><con3:xqueryText>$body/*</con3:xqueryText></con2:expr>
                                    <con2:message><![CDATA[<<<<<<${projectName}|${stageName}|ErrorMessageEncryptedResponse>>>>>>>]]></con2:message>
                                </con2:log>
                                <con3:reply isError="false">
                                    <con3:id>${id()}</con3:id>
                                </con3:reply>
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            <con3:reply isError="false">
                                <con3:id>${id()}</con3:id>
                            </con3:reply>
                        </con1:default>
                    </con1:ifThenElse>
                </con:actions>
            </con:stage>` : "";

      return { name: ehName, xml: `
        <con:pipeline name="${ehName}" type="error" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con2="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
            <con:stage name="${stageName}_EH" id="${sid()}">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con2:log>
                        <con3:id>${id()}</con3:id>
                        <con2:logLevel>debug</con2:logLevel>
                        <con2:expr><con3:xqueryText>$fault</con3:xqueryText></con2:expr>
                        <con2:message><![CDATA[<<<<<<${projectName}|${stageName}|FaultMessage>>>>>>>]]></con2:message>
                    </con2:log>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
${cases.map(c => `                        <con1:case id="${id()}">
                            <con1:condition>
                                <con3:xqueryText>${c.condition}</con3:xqueryText>
                            </con1:condition>
                            <con1:actions>
                                <con1:assign varName="errCode"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>${c.codeExpr || `"${c.code}"`}</con3:xqueryText></con1:expr></con1:assign>
                                <con1:assign varName="errMsg"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>${c.msgExpr || `"${c.message}"`}</con3:xqueryText></con1:expr></con1:assign>
${c.extraActions || ""}
                            </con1:actions>
                        </con1:case>`).join('\n')}
                        <con1:default>
                            <con1:assign varName="errCode"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>"${defaults.code}"</con3:xqueryText></con1:expr></con1:assign>
                            <con1:assign varName="errMsg"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>${defaults.msgExpr}</con3:xqueryText></con1:expr></con1:assign>
                        </con1:default>
                    </con1:ifThenElse>
                    ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr>
                            <con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>{$errCode}</v1:ErrorCode>
<v1:TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</v1:TrackingId>
<v1:ErrorMessage>{$errMsg}</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText>
                        </con1:expr>
                    </con1:replace>`)}
                    <con2:log>
                        <con3:id>${id()}</con3:id>
                        <con2:logLevel>debug</con2:logLevel>
                        <con2:expr><con3:xqueryText>$body/*</con3:xqueryText></con2:expr>
                        <con2:message><![CDATA[<<<<<<${projectName}|${stageName}|ErrorMessageResponse>>>>>>>]]></con2:message>
                    </con2:log>${!encrypt ? `
                    <con3:reply isError="false">
                        <con3:id>${id()}</con3:id>
                    </con3:reply>` : ""}
                </con:actions>
            </con:stage>${encryptionStage}
        </con:pipeline>` };
    };

    // SSF encryption block — uses local opBranch
    const ssfEncryptBlock = (dvmKeyExpr, sourceExpr) => `
                                    ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:type>XML-To-Native</con1:type>
                                        <con1:sourceExpr>
                                            <con3:xqueryText>${sourceExpr}</con3:xqueryText>
                                        </con1:sourceExpr>
                                        <con1:nxsd ref="${nxsdRef}"/>
                                        <con1:schemaElement xmlns:ser="http://TargetNamespace.com/ServiceName">ser:${op.responseElement}</con1:schemaElement>
                                        <con1:replace-body-content/>
                                        <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                                    </con1:nxsdTranslation>`)}
                                    <con1:wsCallout xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:service ref="CommonSBProject/proxy/BinaryText" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                        <con1:request><con1:payload wrapped="true">body</con1:payload></con1:request>
                                        <con1:response><con1:payload wrapped="true">body</con1:payload></con1:response>
                                        <con1:requestTransform/>
                                        <con1:responseTransform/>
                                    </con1:wsCallout>
                                    <con1:javaCallout varName="EncResponse" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                        <con3:id>${id()}</con3:id>
                                        <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                                        <con1:className>cryptlib.CryptLib</con1:className>
                                        <con1:method>public static java.lang.String encrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                                        <con1:expr><con3:xqueryText>fn:data($body)</con3:xqueryText></con1:expr>
                                        <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                                        <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/SSFAESKeys.dvm","service",${dvmKeyExpr},"IV","")</con3:xqueryText></con1:expr>
                                        <con1:return-param-as-ref>false</con1:return-param-as-ref>
                                    </con1:javaCallout>`;

    // ─── Error handler instances ───
    const ehOamAfter = hasMobility ? errorHandler("EH_OAM_AfterLogin", `"${dmzDvmKey}"`, false) : null;
    const ehOamBefore = hasMobility ? errorHandler("EH_OAM_BeforeLogin", `"${dmzDvmKey}"`, false) : null;
    const ehConsumerAfter = hasMobility ? errorHandler("EH_Consumer_AfterLogin", `"${dmzDvmKey}"`, false) : null;
    const ehConsumerBefore = hasMobility ? errorHandler("EH_Consumer_BeforeLogin", `"${dmzDvmKey}"`, false) : null;
    const ehB2BOam = hasB2B ? errorHandler("EH_B2B_OAM", `$subSource`, true) : null;
    const ehB2BAccess = hasB2B ? errorHandler("EH_B2B_Access", `$subSource`, true) : null;
    const ehSSFOam = hasSSF ? ssfErrorHandler("EH_SSF_OAM", [
      { condition: `$fault/ctx:errorCode = 'OSB-382500'`, code: "401", message: "Unauthorized",
        extraActions: `                                <con1:insert varName="inbound" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:location><con3:xpathText>./ctx:transport/ctx:response</con3:xpathText></con1:location>
                                    <con1:where>last-child</con1:where>
                                    <con1:expr><con3:xqueryText>&lt;http:http-response-code>401&lt;/http:http-response-code></con3:xqueryText></con1:expr>
                                </con1:insert>` },
    ], false, { code: "IDAM-500", msgExpr: `$Res//*:ErrorMessage/text()` }) : null;
    const ehSSFPartner = hasSSF ? ssfErrorHandler("EH_SSF_Partner", [
      { condition: `$fault/ctx:errorCode = 'InvalidLoginId01'`, code: "100", message: "SSFPartnerLoginId Not Match" },
      { condition: `$fault/ctx:errorCode = 'NullLoginId001'`, code: "100", message: "SSFPartnerLoginId is Null" },
      { condition: `$fault/ctx:errorCode = 'NullLoginId002'`, code: "100", message: "OAuth LoginId is Null" },
    ], true) : null;

    // ─── SSF stage templates (use local opBranch) ───
    const ssfDecStage = `
            <con:stage id="${sid()}" name="SSF DEC Request Stage" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con2:log>
                        <con3:id>${id()}</con3:id>
                        <con2:logLevel>debug</con2:logLevel>
                        <con2:expr><con3:xqueryText>$inbound</con3:xqueryText></con2:expr>
                        <con2:message><![CDATA[<<<<<<${projectName}|${serviceName}|SSF_Inbound>>>>>>>]]></con2:message>
                    </con2:log>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>fn:not((fn:exists($OriginalMessage/v1:${op.requestElement}/v1:Source)) or (fn:exists($OriginalMessage/v1:${op.requestElement}/v1:SSFPartnerLoginId)))</con3:xqueryText></con1:condition>
                            <con1:actions/>
                        </con1:case>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>(not(fn:exists($OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload)))</con3:xqueryText></con1:condition>
                            <con1:actions>
                                ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>100</v1:ErrorCode>
<v1:ErrorSubCode>106</v1:ErrorSubCode>
<v1:TrackingId>{fn:data($body/v1:${op.requestElement}/v1:TrackingId)}</v1:TrackingId>
<v1:ErrorMessage>Please update the app.</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                </con1:replace>`)}
                                ${ssfMd5Key(ssfDvmKeyExpr)}
                                ${ssfEncryptBlock(ssfDvmKeyExpr, "$body/*")}
                                ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>100</ErrorCode>
<ErrorSubCode>106</ErrorSubCode>
<ErrorMessage>Please update the app.</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                </con1:replace>`)}
                                <con3:reply isError="false"><con3:id>${id()}</con3:id></con3:reply>
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                <con3:id>${id()}</con3:id>
                                <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>100</v1:ErrorCode>
<v1:ErrorSubCode>106</v1:ErrorSubCode>
<v1:TrackingId>{fn:data($body/v1:${op.requestElement}/v1:TrackingId)}</v1:TrackingId>
<v1:ErrorMessage>Please update the app.</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                            </con1:replace>`)}
                            ${ssfMd5Key(ssfDvmKeyExpr)}
                            ${ssfEncryptBlock(ssfDvmKeyExpr, "$body/*")}
                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                <con3:id>${id()}</con3:id>
                                <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>100</ErrorCode>
<ErrorSubCode>106</ErrorSubCode>
<ErrorMessage>Please update the app.</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                            </con1:replace>`)}
                            <con3:reply isError="false"><con3:id>${id()}</con3:id></con3:reply>
                        </con1:default>
                    </con1:ifThenElse>
                    <con1:assign varName="TrackingId" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$body/v1:${op.requestElement}/v1:TrackingId/text()</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:assign varName="Flag" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/SSFAESKeys.dvm","service",${ssfDvmKeyExpr},"Status","Y")</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>(fn:exists($OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload/text())) and ($Flag = "Y")</con3:xqueryText></con1:condition>
                            <con1:actions>
                                <con1:assign varName="EncData">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText>$OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload/text()</con3:xqueryText></con1:expr>
                                </con1:assign>
                                ${ssfMd5Key(ssfDvmKeyExpr)}
                                <con1:javaCallout varName="result">
                                    <con3:id>${id()}</con3:id>
                                    <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                                    <con1:className>cryptlib.CryptLib</con1:className>
                                    <con1:method>public static java.lang.String decrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                                    <con1:expr><con3:xqueryText>$EncData</con3:xqueryText></con1:expr>
                                    <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                                    <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/SSFAESKeys.dvm","service",${ssfDvmKeyExpr},"IV","")</con3:xqueryText></con1:expr>
                                    <con1:return-param-as-ref>false</con1:return-param-as-ref>
                                </con1:javaCallout>
                                <con1:ifThenElse>
                                    <con3:id>${id()}</con3:id>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>not(fn:contains($result,"ERROR-"))</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:type>Native-To-XML</con1:type>
                                                <con1:sourceExpr><con3:xqueryText>$result</con3:xqueryText></con1:sourceExpr>
                                                <con1:nxsd ref="${nxsdRef}"/>
                                                <con1:schemaElement xmlns:ser="http://TargetNamespace.com/ServiceName">ser:${op.requestElement}</con1:schemaElement>
                                                <con1:assign-variable>xmlresult</con1:assign-variable>
                                                <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                                            </con1:nxsdTranslation>
                                            <con1:replace varName="OriginalMessage" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:expr><con3:xqueryText>&lt;v1:${op.requestElement}>
&lt;v1:TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}&lt;/v1:TrackingId>
{$xmlresult/*}
&lt;/v1:${op.requestElement}></con3:xqueryText></con1:expr>
                                            </con1:replace>`)}
                                        </con1:actions>
                                    </con1:case>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>fn:contains($result,"ERROR-")</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>1</v1:ErrorCode>
<v1:TrackingId>{$TrackingId}</v1:TrackingId>
<v1:ErrorMessage>{$result}</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                            </con1:replace>`)}
                                            ${ssfEncryptBlock(ssfDvmKeyExpr, "$body/*")}
                                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>1</ErrorCode>
<ErrorSubCode>1</ErrorSubCode>
<ErrorMessage>{$result}</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                            </con1:replace>`)}
                                            <con3:reply isError="false"><con3:id>${id()}</con3:id></con3:reply>
                                        </con1:actions>
                                    </con1:case>
                                    <con1:default/>
                                </con1:ifThenElse>
                            </con1:actions>
                        </con1:case>
                        <con1:default/>
                    </con1:ifThenElse>
                    <con1:assign varName="validate" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>if(fn:exists($OriginalMessage/v1:${op.requestElement}/v1:SSFPartnerLoginId/text())) then "SSF" else "Default"</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$OriginalMessage/*</con3:xqueryText></con1:expr>
                    </con1:replace>
                </con:actions>
            </con:stage>`;

    const ssfEncStage = `
            <con:stage id="${sid()}" name="SSF ENC Response Stage" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:assign varName="output" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$body/*</con3:xqueryText></con1:expr>
                    </con1:assign>
                    ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:type>XML-To-Native</con1:type>
                        <con1:sourceExpr><con3:xqueryText>$output</con3:xqueryText></con1:sourceExpr>
                        <con1:nxsd ref="${nxsdRef}"/>
                        <con1:schemaElement xmlns:ser="http://TargetNamespace.com/ServiceName">ser:${op.responseElement}</con1:schemaElement>
                        <con1:replace-body-content/>
                        <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                    </con1:nxsdTranslation>`)}
                    <con1:wsCallout xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:service ref="CommonSBProject/proxy/BinaryText" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:request><con1:payload wrapped="true">body</con1:payload></con1:request>
                        <con1:response><con1:payload wrapped="true">body</con1:payload></con1:response>
                        <con1:requestTransform/>
                        <con1:responseTransform/>
                    </con1:wsCallout>
                    ${ssfMd5Key(ssfDvmKeyExpr)}
                    <con1:javaCallout varName="EncResponse" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                        <con1:className>cryptlib.CryptLib</con1:className>
                        <con1:method>public static java.lang.String encrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                        <con1:expr><con3:xqueryText>fn:data($body)</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/SSFAESKeys.dvm","service",${ssfDvmKeyExpr},"IV","")</con3:xqueryText></con1:expr>
                        <con1:return-param-as-ref>false</con1:return-param-as-ref>
                    </con1:javaCallout>
                    ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>{$output/*:ErrorCode/text()}</ErrorCode>
<ErrorMessage>{$output/*:ErrorMessage/text()}</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                    </con1:replace>`)}
                </con:actions>
            </con:stage>`;

    const ssfOamStage = !hasSSF ? "" : `
            <con:stage name="SSFValidateTokenOAMCallStage" errorHandler="${ehSSFOam.name}" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:wsCallout xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:service ref="OAMSSFUserProfileSBProject/proxy/SSFUserProfilePS_Local" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:request><con1:payload wrapped="false">Req</con1:payload></con1:request>
                        <con1:response><con1:payload wrapped="false">Res</con1:payload></con1:response>
                        <con1:requestTransform>
                            <con1:transport-headers copy-all="false">
                                <con3:id>${id()}</con3:id>
                                <con1:header-set>outbound-request</con1:header-set>
                                <con1:header name="Authorization" value="expression"><con3:xqueryText>$headerAuthorizationValue</con3:xqueryText></con1:header>
                            </con1:transport-headers>
                        </con1:requestTransform>
                        <con1:responseTransform>
                            <con1:ifThenElse>
                                <con3:id>${id()}</con3:id>
                                <con1:case id="${id()}">
                                    <con1:condition><con3:xqueryText>$Res//*:uid/text() !=" "</con3:xqueryText></con1:condition>
                                    <con1:actions/>
                                </con1:case>
                                <con1:default>
                                    <con1:Error><con3:id>${id()}</con3:id><con1:errCode>IDAM-Error</con1:errCode><con1:message>SSF IDAM Validation Failed</con1:message></con1:Error>
                                </con1:default>
                            </con1:ifThenElse>
                        </con1:responseTransform>
                    </con1:wsCallout>
                </con:actions>
            </con:stage>`;

    const ssfPartnerStage = `
            <con:stage name="SSFPartnerProfileStage" errorHandler="${ehSSFPartner.name}" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>fn:exists($OriginalMessage/v1:${op.requestElement}/v1:SSFPartnerLoginId/text())</con3:xqueryText></con1:condition>
                            <con1:actions>
                                <con1:ifThenElse>
                                    <con3:id>${id()}</con3:id>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>fn:exists($Res//*:uid/text())</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            <con1:ifThenElse>
                                                <con3:id>${id()}</con3:id>
                                                <con1:case id="${id()}">
                                                    <con1:condition><con3:xqueryText>$OriginalMessage/v1:${op.requestElement}/v1:SSFPartnerLoginId/text() = $Res//*:uid/text()</con3:xqueryText></con1:condition>
                                                    <con1:actions/>
                                                </con1:case>
                                                <con1:default>
                                                    <con1:Error><con3:id>${id()}</con3:id><con1:errCode>InvalidLoginId01</con1:errCode><con1:message>SSFPartnerLoginId does not match OAM uid</con1:message></con1:Error>
                                                </con1:default>
                                            </con1:ifThenElse>
                                        </con1:actions>
                                    </con1:case>
                                    <con1:default>
                                        <con1:Error><con3:id>${id()}</con3:id><con1:errCode>NullLoginId002</con1:errCode><con1:message>OAuth LoginId is Null</con1:message></con1:Error>
                                    </con1:default>
                                </con1:ifThenElse>
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            <con1:Error><con3:id>${id()}</con3:id><con1:errCode>NullLoginId001</con1:errCode><con1:message>SSFPartnerLoginId is Null</con1:message></con1:Error>
                        </con1:default>
                    </con1:ifThenElse>
                </con:actions>
            </con:stage>
            <con:stage name="SSFDeletionExtraElementsStage" id="${sid()}" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    ${opBranch(op => `<con3:delete varName="body" xmlns:con3="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con1="http://www.bea.com/wli/sb/stages/config">
                        <con1:id>${id()}</con1:id>
                        <con3:location>
                            <con1:xpathText>.//v1:${op.requestElement}/v1:SSFPartnerLoginId</con1:xpathText>
                        </con3:location>
                    </con3:delete>`)}
                </con:actions>
            </con:stage>`;

    // ─── Route node for this operation (direct, no branch-table) ───
    const routeNode = `
                            <con:route-node name="RouteNode_${op.operationName}">
                                <con:context/>
                                <con:actions>
                                    <con1:route xmlns:con1="http://www.bea.com/wli/sb/stages/routing/config">
                                        <con3:id xmlns:con3="http://www.bea.com/wli/sb/stages/config">${id()}</con3:id>
                                        <con1:service ref="${bsRef}" xsi:type="ref:BusinessServiceRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                                        <con1:operation>${op.operationName}</con1:operation>
                                        <con1:outboundTransform>
                                            <con2:log xmlns:con2="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                                                <con3:id>${id()}</con3:id>
                                                <con2:logLevel>debug</con2:logLevel>
                                                <con2:expr><con3:xqueryText>$body</con3:xqueryText></con2:expr>
                                                <con2:message><![CDATA[<<<<<<${projectName}|${op.operationName}|RoutingRequestMessage>>>>>>>]]></con2:message>
                                            </con2:log>
                                        </con1:outboundTransform>
                                        <con1:responseTransform>
                                            <con2:log xmlns:con2="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                                                <con3:id>${id()}</con3:id>
                                                <con2:logLevel>debug</con2:logLevel>
                                                <con2:expr><con3:xqueryText>$body</con3:xqueryText></con2:expr>
                                                <con2:message><![CDATA[<<<<<<${projectName}|${op.operationName}|RoutingResponseMessage>>>>>>>]]></con2:message>
                                            </con2:log>
                                            <con1:assign varName="output" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:expr><con3:xqueryText>$body/*</con3:xqueryText></con1:expr>
                                            </con1:assign>
                                        </con1:responseTransform>
                                    </con1:route>
                                </con:actions>
                            </con:route-node>`;

    // ─── Mobility pipelines ───
    const mobilityPipelines = hasMobility ? `
        <con:pipeline type="request" name="${reqDecMob}">
            <con:stage id="${sid()}" name="DEC Request Stage" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con2:log>
                        <con3:id>${id()}</con3:id>
                        <con2:logLevel>debug</con2:logLevel>
                        <con2:expr><con3:xqueryText>$inbound</con3:xqueryText></con2:expr>
                        <con2:message><![CDATA[<<<<<<${projectName}|${serviceName}|Inbound>>>>>>>]]></con2:message>
                    </con2:log>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>fn:not((fn:exists($OriginalMessage/v1:${op.requestElement}/v1:Source)) or (fn:exists($OriginalMessage/v1:${op.requestElement}/v1:LoginType)) or (fn:exists($OriginalMessage/v1:${op.requestElement}/v1:ContactUCMId)))</con3:xqueryText></con1:condition>
                            <con1:actions/>
                        </con1:case>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>(not(fn:exists($OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload)))</con3:xqueryText></con1:condition>
                            <con1:actions>
                                ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>100</v1:ErrorCode>
<v1:TrackingId>{fn:data($body/v1:${op.requestElement}/v1:TrackingId)}</v1:TrackingId>
<v1:ErrorMessage>Please update the app.</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                </con1:replace>`)}
                                ${md5Key(`"${dmzDvmKey}"`)}
                                ${encryptBlock(`"${dmzDvmKey}"`, "$body/*")}
                                ${encReplaceReply(false)}
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                <con3:id>${id()}</con3:id>
                                <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>100</v1:ErrorCode>
<v1:TrackingId>{fn:data($body/v1:${op.requestElement}/v1:TrackingId)}</v1:TrackingId>
<v1:ErrorMessage>Please update the app.</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                            </con1:replace>`)}
                            ${md5Key(`"${dmzDvmKey}"`)}
                            ${encryptBlock(`"${dmzDvmKey}"`, "$body/*")}
                            ${encReplaceReply(false)}
                        </con1:default>
                    </con1:ifThenElse>
                    <con1:assign varName="TrackingId" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$body/v1:${op.requestElement}/v1:TrackingId/text()</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>(fn:exists($OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload/text()))</con3:xqueryText></con1:condition>
                            <con1:actions>
                                <con1:assign varName="EncData">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText>$OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload/text()</con3:xqueryText></con1:expr>
                                </con1:assign>
                                ${md5Key(`"${dmzDvmKey}"`)}
                                <con1:javaCallout varName="result">
                                    <con3:id>${id()}</con3:id>
                                    <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                                    <con1:className>cryptlib.CryptLib</con1:className>
                                    <con1:method>public static java.lang.String decrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                                    <con1:expr><con3:xqueryText>$EncData</con3:xqueryText></con1:expr>
                                    <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                                    <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/AESKeys.dvm","service","${dmzDvmKey}","IV","")</con3:xqueryText></con1:expr>
                                    <con1:return-param-as-ref>false</con1:return-param-as-ref>
                                </con1:javaCallout>
                                <con1:ifThenElse>
                                    <con3:id>${id()}</con3:id>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>not(fn:contains($result,"ERROR-"))</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:type>Native-To-XML</con1:type>
                                                <con1:sourceExpr><con3:xqueryText>$result</con3:xqueryText></con1:sourceExpr>
                                                <con1:nxsd ref="${nxsdRef}"/>
                                                <con1:schemaElement xmlns:ser="http://TargetNamespace.com/ServiceName">ser:${op.requestElement}</con1:schemaElement>
                                                <con1:assign-variable>xmlresult</con1:assign-variable>
                                                <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                                            </con1:nxsdTranslation>
                                            <con1:replace varName="OriginalMessage" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:expr><con3:xqueryText>&lt;v1:${op.requestElement}>
&lt;v1:TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}&lt;/v1:TrackingId>
{$xmlresult/*}
&lt;/v1:${op.requestElement}></con3:xqueryText></con1:expr>
                                            </con1:replace>`)}
                                        </con1:actions>
                                    </con1:case>
                                    <con1:case id="${id()}">
                                        <con1:condition><con3:xqueryText>fn:contains($result,"ERROR-")</con3:xqueryText></con1:condition>
                                        <con1:actions>
                                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                                <con3:id>${id()}</con3:id>
                                                <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>1</v1:ErrorCode>
<v1:TrackingId>{$TrackingId}</v1:TrackingId>
<v1:ErrorMessage>{$result}</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                                            </con1:replace>`)}
                                            ${encryptBlock(`"${dmzDvmKey}"`, "$body/*")}
                                            ${encReplaceReply(false)}
                                        </con1:actions>
                                    </con1:case>
                                </con1:ifThenElse>
                            </con1:actions>
                        </con1:case>
                        <con1:default/>
                    </con1:ifThenElse>
                    <con1:assign varName="validate" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>if (fn:exists($OriginalMessage/v1:${op.requestElement}/v1:LoginType)) then "Consumer" else ""</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$OriginalMessage/*</con3:xqueryText></con1:expr>
                    </con1:replace>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="response" name="${resEncMob}">
            <con:stage id="${sid()}" name="ENC Response Stage1" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:assign varName="output" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$body/*</con3:xqueryText></con1:expr>
                    </con1:assign>
                    ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:type>XML-To-Native</con1:type>
                        <con1:sourceExpr><con3:xqueryText>$output</con3:xqueryText></con1:sourceExpr>
                        <con1:nxsd ref="${nxsdRef}"/>
                        <con1:schemaElement xmlns:ser="http://TargetNamespace.com/ServiceName">ser:${op.responseElement}</con1:schemaElement>
                        <con1:replace-body-content/>
                        <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                    </con1:nxsdTranslation>`)}
                    <con1:wsCallout xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:service ref="CommonSBProject/proxy/BinaryText" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:request><con1:payload wrapped="true">body</con1:payload></con1:request>
                        <con1:response><con1:payload wrapped="true">body</con1:payload></con1:response>
                        <con1:requestTransform/>
                        <con1:responseTransform/>
                    </con1:wsCallout>
                    <con1:javaCallout varName="EncResponse" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                        <con1:className>cryptlib.CryptLib</con1:className>
                        <con1:method>public static java.lang.String encrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                        <con1:expr><con3:xqueryText>fn:data($body)</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>dvm:lookup("CommonSBProject/dvm/AESKeys.dvm","service","${dmzDvmKey}","IV","")</con3:xqueryText></con1:expr>
                        <con1:return-param-as-ref>false</con1:return-param-as-ref>
                    </con1:javaCallout>
                    ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>{$output/*:ErrorCode/text()}</ErrorCode>
<ErrorMessage>{$output/*:ErrorMessage/text()}</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                    </con1:replace>`)}
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="request" name="${reqContactVal}">
            <con:stage name="ContactUCMIdValidationStage" id="${sid()}" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:assign varName="ContactUCMIdValidate" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>if (fn:exists($OriginalMessage/v1:${op.requestElement}/v1:ContactUCMId/text()) and fn:string-length($OriginalMessage/v1:${op.requestElement}/v1:ContactUCMId/text()) > 0) then "AfterLogin" else "BeforeLogin"</con3:xqueryText></con1:expr>
                    </con1:assign>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="response" name="${resContactVal}"/>
        <con:pipeline type="request" name="${reqAfterLogin}">
            ${oamStage(ehOamAfter.name, op.requestElement)}
            ${consumerProfileStage(ehConsumerAfter.name, true, op.requestElement)}
            ${deletionStage(op.requestElement)}
        </con:pipeline>
        <con:pipeline type="response" name="${resAfterLogin}"/>
        <con:pipeline type="request" name="${reqBeforeLogin}">
            ${oamStage(ehOamBefore.name, op.requestElement)}
            ${consumerProfileStage(ehConsumerBefore.name, false, op.requestElement)}
            ${deletionStage(op.requestElement)}
        </con:pipeline>
        <con:pipeline type="response" name="${resBeforeLogin}"/>
        ${ehOamAfter.xml}
        ${ehOamBefore.xml}
        ${ehConsumerAfter.xml}
        ${ehConsumerBefore.xml}` : "";

    // ─── B2B pipelines ───
    const b2bPipelines = hasB2B ? `
        <con:pipeline type="request" name="${reqB2BAccess}">
            <con:stage name="ServiceAccessCheckStage" errorHandler="${ehB2BAccess.name}" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:assign varName="subSource" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>fn:upper-case($subSource)</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:assign varName="serviceURI" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>fn:concat(fn:data($inbound/ctx:transport/ctx:uri),'/',fn:data($inbound/ctx:transport/ctx:request/http:relative-URI))</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:ifThenElse xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>dvm:lookupValue('CommonSBProject/dvm/B2BServiceAccessList','ServiceURI',$serviceURI,'AccessFlag','Undefined',('Source',$subSource)) = 'Y'</con3:xqueryText></con1:condition>
                            <con1:actions/>
                        </con1:case>
                        <con1:default>
                            <con1:Error><con3:id>${id()}</con3:id><con1:errCode>ServiceAccessDenied</con1:errCode><con1:message>You are not authorized to access this service</con1:message></con1:Error>
                        </con1:default>
                    </con1:ifThenElse>
                </con:actions>
            </con:stage>
            <con:stage name="DecryptionStage" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    ${md5Key("$subSource")}
                    <con1:assign varName="EncData">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$OriginalMessage/v1:${op.requestElement}/v1:UpdatedEncPayload/text()</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:javaCallout varName="result">
                        <con3:id>${id()}</con3:id>
                        <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                        <con1:className>cryptlib.CryptLib</con1:className>
                        <con1:method>public static java.lang.String decrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                        <con1:expr><con3:xqueryText>$EncData</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>dvm:lookup('CommonSBProject/dvm/AESKeys.dvm','service',$subSource,'IV','')</con3:xqueryText></con1:expr>
                        <con1:return-param-as-ref>false</con1:return-param-as-ref>
                    </con1:javaCallout>
                    <con1:ifThenElse>
                        <con3:id>${id()}</con3:id>
                        <con1:case id="${id()}">
                            <con1:condition><con3:xqueryText>not(fn:contains($result,"ERROR-"))</con3:xqueryText></con1:condition>
                            <con1:actions>
                                ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:type>Native-To-XML</con1:type>
                                    <con1:sourceExpr><con3:xqueryText>$result</con3:xqueryText></con1:sourceExpr>
                                    <con1:nxsd ref="${nxsdRef}"/>
                                    <con1:schemaElement xmlns:v1="${namespace}">v1:${op.requestElement}</con1:schemaElement>
                                    <con1:assign-variable>xmlresult</con1:assign-variable>
                                    <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                                </con1:nxsdTranslation>
                                <con1:replace varName="OriginalMessage" contents-only="false" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText>&lt;v1:${op.requestElement}>
&lt;v1:TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}&lt;/v1:TrackingId>
{$xmlresult/*}
&lt;/v1:${op.requestElement}></con3:xqueryText></con1:expr>
                                </con1:replace>`)}
                                <con1:replace varName="body" contents-only="true">
                                    <con3:id>${id()}</con3:id>
                                    <con1:expr><con3:xqueryText>$OriginalMessage/*</con3:xqueryText></con1:expr>
                                </con1:replace>
                            </con1:actions>
                        </con1:case>
                        <con1:default>
                            <con1:assign varName="errCode"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>"1"</con3:xqueryText></con1:expr></con1:assign>
                            <con1:assign varName="errMsg"><con3:id>${id()}</con3:id><con1:expr><con3:xqueryText>$result</con3:xqueryText></con1:expr></con1:assign>
                            ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                                <con3:id>${id()}</con3:id>
                                <con1:expr><con3:xqueryText><![CDATA[<v1:${op.responseElement}>
<v1:ErrorCode>1</v1:ErrorCode>
<v1:TrackingId>{$TrackingId}</v1:TrackingId>
<v1:ErrorMessage>{$result}</v1:ErrorMessage>
</v1:${op.responseElement}>]]></con3:xqueryText></con1:expr>
                            </con1:replace>`)}
                            ${encryptBlock("$subSource", "$body/*")}
                            ${encReplaceReply(true)}
                        </con1:default>
                    </con1:ifThenElse>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="response" name="${resB2BEnc}">
            <con:stage name="B2BEncStage" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context/>
                <con:actions>
                    ${opBranch(op => `<con1:nxsdTranslation xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:type>XML-To-Native</con1:type>
                        <con1:sourceExpr><con3:xqueryText>$output</con3:xqueryText></con1:sourceExpr>
                        <con1:nxsd ref="${nxsdRef}"/>
                        <con1:schemaElement xmlns:v1="${namespace}">v1:${op.responseElement}</con1:schemaElement>
                        <con1:replace-body-content/>
                        <con1:enforceSchemaOrder>false</con1:enforceSchemaOrder>
                    </con1:nxsdTranslation>`)}
                    <con1:wsCallout>
                        <con3:id>${id()}</con3:id>
                        <con1:service ref="CommonSBProject/proxy/BinaryText" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:request><con1:payload wrapped="true">body</con1:payload></con1:request>
                        <con1:response><con1:payload wrapped="true">body</con1:payload></con1:response>
                        <con1:requestTransform/>
                        <con1:responseTransform/>
                    </con1:wsCallout>
                    <con1:javaCallout varName="EncResponse">
                        <con3:id>${id()}</con3:id>
                        <con1:archive ref="CommonSBProject/jar/CryptLib"/>
                        <con1:className>cryptlib.CryptLib</con1:className>
                        <con1:method>public static java.lang.String encrypt(java.lang.String, java.lang.String, java.lang.String)</con1:method>
                        <con1:expr><con3:xqueryText>fn:data($body)</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>$key</con3:xqueryText></con1:expr>
                        <con1:expr><con3:xqueryText>dvm:lookup('CommonSBProject/dvm/AESKeys.dvm','service',$subSource,'IV','')</con3:xqueryText></con1:expr>
                        <con1:return-param-as-ref>false</con1:return-param-as-ref>
                    </con1:javaCallout>
                    ${opBranch(op => `<con1:replace varName="body" contents-only="true" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText><![CDATA[<${op.responseElement}>
<TrackingId>{$OriginalMessage/v1:${op.requestElement}/v1:TrackingId/text()}</TrackingId>
<EncResponse>{$EncResponse}</EncResponse>
<ErrorCode>{$output/*:ErrorCode/text()}</ErrorCode>
<ErrorSubCode>{$output/*:ErrorCode/text()}</ErrorSubCode>
<ErrorMessage>{$output/*:ErrorMessage/text()}</ErrorMessage>
</${op.responseElement}>]]></con3:xqueryText></con1:expr>
                    </con1:replace>`)}
                    <con3:reply><con3:id>${id()}</con3:id></con3:reply>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="request" name="${reqB2BOam}">
            <con:stage name="B2BValidateTokenOAMCallStage" errorHandler="${ehB2BOam.name}" id="${sid()}" xmlns:con1="http://www.bea.com/wli/sb/stages/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v1" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:wsCallout xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:service ref="OAMB2BUserProfileSBProject/proxy/LocalB2BUserProfilePS" xsi:type="ref:ProxyRef" xmlns:ref="http://www.bea.com/wli/sb/reference"/>
                        <con1:request><con1:payload wrapped="false">Req</con1:payload></con1:request>
                        <con1:response><con1:payload wrapped="false">Res</con1:payload></con1:response>
                        <con1:requestTransform>
                            <con1:transport-headers copy-all="false">
                                <con3:id>${id()}</con3:id>
                                <con1:header-set>outbound-request</con1:header-set>
                                <con1:header name="Authorization" value="expression"><con3:xqueryText>$headerAuthorizationValue</con3:xqueryText></con1:header>
                            </con1:transport-headers>
                        </con1:requestTransform>
                        <con1:responseTransform>
                            <con1:ifThenElse>
                                <con3:id>${id()}</con3:id>
                                <con1:case id="${id()}">
                                    <con1:condition><con3:xqueryText>fn:lower-case($Res//*:uid/text()) = fn:lower-case($subSource)</con3:xqueryText></con1:condition>
                                    <con1:actions/>
                                </con1:case>
                                <con1:default>
                                    <con1:Error><con3:id>${id()}</con3:id><con1:errCode>IDAM-Error</con1:errCode><con1:message>B2B IDAM Validation Failed - UID mismatch</con1:message></con1:Error>
                                </con1:default>
                            </con1:ifThenElse>
                        </con1:responseTransform>
                    </con1:wsCallout>
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="response" name="${resB2BOam}"/>
        ${ehB2BAccess.xml}
        ${ehB2BOam.xml}` : "";

    // ─── SSF pipelines ───
    const ssfPipelines = hasSSF ? `
        <con:pipeline type="request" name="${reqSSFDec}">
            ${ssfDecStage}
        </con:pipeline>
        <con:pipeline type="response" name="${resSSFEnc}">
            ${ssfEncStage}
        </con:pipeline>
        <con:pipeline type="request" name="${reqSSFOam}">
            ${ssfOamStage}
        </con:pipeline>
        <con:pipeline type="response" name="${resSSFOam}"/>
        <con:pipeline type="request" name="${reqSSFPartner}">
            ${ssfPartnerStage}
        </con:pipeline>
        <con:pipeline type="response" name="${resSSFPartner}"/>
        ${ehSSFOam.xml}
        ${ehSSFPartner.xml}` : "";

    // ─── All pipeline definitions for this operation ───
    const pipelines = `${mobilityPipelines}
${b2bPipelines}
${ssfPipelines}`;

    // ─── Build per-op flow (the inner content of this operation's branch) ───
    let flow;
    if (multiChannel) {
      // Channel branching within this operation
      const mobilityFlow = hasMobility ? `
                    <con:branch name="Mobility">
                        <con:operator>equals</con:operator>
                        <con:value>'Mobility'</con:value>
                        <con:flow>
                            <con:pipeline-node name="Pipeline Pair Node5_${op.operationName}">
                                <con:request>${reqDecMob}</con:request>
                                <con:response>${resEncMob}</con:response>
                            </con:pipeline-node>
                            <con:branch-node type="condition" id="${id()}" name="Consumer/Partner">
                                <con:context/>
                                <con:branch-table variable="validate">
                                    <con:branch name="Consumer">
                                        <con:operator>equals</con:operator>
                                        <con:value>'Consumer'</con:value>
                                        <con:flow>
                                            <con:pipeline-node name="Pipeline Pair Node2_${op.operationName}">
                                                <con:request>${reqContactVal}</con:request>
                                                <con:response>${resContactVal}</con:response>
                                            </con:pipeline-node>
                                            <con:branch-node type="condition" id="${id()}" name="BranchNode2">
                                                <con:context/>
                                                <con:branch-table variable="ContactUCMIdValidate">
                                                    <con:branch name="AfterLogin">
                                                        <con:operator>equals</con:operator>
                                                        <con:value>'AfterLogin'</con:value>
                                                        <con:flow>
                                                            <con:pipeline-node name="Pipeline Pair Node3_${op.operationName}">
                                                                <con:request>${reqAfterLogin}</con:request>
                                                                <con:response>${resAfterLogin}</con:response>
                                                            </con:pipeline-node>
                                                            ${routeNode}
                                                        </con:flow>
                                                    </con:branch>
                                                    <con:branch name="BeforeLogin">
                                                        <con:operator>equals</con:operator>
                                                        <con:value>'BeforeLogin'</con:value>
                                                        <con:flow>
                                                            <con:pipeline-node name="Pipeline Pair Node4_${op.operationName}">
                                                                <con:request>${reqBeforeLogin}</con:request>
                                                                <con:response>${resBeforeLogin}</con:response>
                                                            </con:pipeline-node>
                                                            ${routeNode}
                                                        </con:flow>
                                                    </con:branch>
                                                    <con:default-branch>
                                                        <con:flow/>
                                                    </con:default-branch>
                                                </con:branch-table>
                                            </con:branch-node>
                                        </con:flow>
                                    </con:branch>
                                    <con:default-branch>
                                        <con:flow/>
                                    </con:default-branch>
                                </con:branch-table>
                            </con:branch-node>
                        </con:flow>
                    </con:branch>` : "";

      const b2bFlow = hasB2B ? `
                    <con:branch name="B2B">
                        <con:operator>equals</con:operator>
                        <con:value>'B2B'</con:value>
                        <con:flow>
                            <con:pipeline-node name="Pipeline Pair Node8_${op.operationName}">
                                <con:request>${reqB2BAccess}</con:request>
                                <con:response>${resB2BEnc}</con:response>
                            </con:pipeline-node>
                            <con:pipeline-node name="Pipeline Pair Node9_${op.operationName}">
                                <con:request>${reqB2BOam}</con:request>
                                <con:response>${resB2BOam}</con:response>
                            </con:pipeline-node>
                            ${routeNode}
                        </con:flow>
                    </con:branch>` : "";

      const ssfFlow = hasSSF ? `
                    <con:branch name="SSF">
                        <con:operator>equals</con:operator>
                        <con:value>'SSF'</con:value>
                        <con:flow>
                            <con:pipeline-node name="Pipeline Pair NodeSSFDec_${op.operationName}">
                                <con:request>${reqSSFDec}</con:request>
                                <con:response>${resSSFEnc}</con:response>
                            </con:pipeline-node>
                            <con:branch-node type="condition" id="${id()}" name="ValidateBranch_${op.operationName}">
                                <con:context/>
                                <con:branch-table variable="validate">
                                    <con:branch name="SSF">
                                        <con:operator>equals</con:operator>
                                        <con:value>'SSF'</con:value>
                                        <con:flow>
                                            <con:pipeline-node name="Pipeline Pair NodeSSFOam_${op.operationName}">
                                                <con:request>${reqSSFOam}</con:request>
                                                <con:response>${resSSFOam}</con:response>
                                            </con:pipeline-node>
                                            <con:pipeline-node name="Pipeline Pair NodeSSFPartner_${op.operationName}">
                                                <con:request>${reqSSFPartner}</con:request>
                                                <con:response>${resSSFPartner}</con:response>
                                            </con:pipeline-node>
                                            ${routeNode}
                                        </con:flow>
                                    </con:branch>
                                    <con:default-branch>
                                        <con:flow/>
                                    </con:default-branch>
                                </con:branch-table>
                            </con:branch-node>
                        </con:flow>
                    </con:branch>` : "";

      flow = `
                <con:branch-node type="condition" id="${id()}" name="ChannelType_${op.operationName}">
                    <con:context/>
                    <con:branch-table variable="channelType">
                        ${mobilityFlow}
                        ${b2bFlow}
                        ${ssfFlow}
                        <con:default-branch>
                            <con:flow/>
                        </con:default-branch>
                    </con:branch-table>
                </con:branch-node>`;
    } else {
      // Single channel — direct flow
      if (hasMobility) {
        flow = `
                <con:pipeline-node name="Pipeline Pair Node5_${op.operationName}">
                    <con:request>${reqDecMob}</con:request>
                    <con:response>${resEncMob}</con:response>
                </con:pipeline-node>
                <con:branch-node type="condition" id="${id()}" name="Consumer/Partner">
                    <con:context/>
                    <con:branch-table variable="validate">
                        <con:branch name="Consumer">
                            <con:operator>equals</con:operator>
                            <con:value>'Consumer'</con:value>
                            <con:flow>
                                <con:pipeline-node name="Pipeline Pair Node2_${op.operationName}">
                                    <con:request>${reqContactVal}</con:request>
                                    <con:response>${resContactVal}</con:response>
                                </con:pipeline-node>
                                <con:branch-node type="condition" id="${id()}" name="BranchNode2">
                                    <con:context/>
                                    <con:branch-table variable="ContactUCMIdValidate">
                                        <con:branch name="AfterLogin">
                                            <con:operator>equals</con:operator>
                                            <con:value>'AfterLogin'</con:value>
                                            <con:flow>
                                                <con:pipeline-node name="Pipeline Pair Node3_${op.operationName}">
                                                    <con:request>${reqAfterLogin}</con:request>
                                                    <con:response>${resAfterLogin}</con:response>
                                                </con:pipeline-node>
                                                ${routeNode}
                                            </con:flow>
                                        </con:branch>
                                        <con:branch name="BeforeLogin">
                                            <con:operator>equals</con:operator>
                                            <con:value>'BeforeLogin'</con:value>
                                            <con:flow>
                                                <con:pipeline-node name="Pipeline Pair Node4_${op.operationName}">
                                                    <con:request>${reqBeforeLogin}</con:request>
                                                    <con:response>${resBeforeLogin}</con:response>
                                                </con:pipeline-node>
                                                ${routeNode}
                                            </con:flow>
                                        </con:branch>
                                        <con:default-branch>
                                            <con:flow/>
                                        </con:default-branch>
                                    </con:branch-table>
                                </con:branch-node>
                            </con:flow>
                        </con:branch>
                        <con:default-branch>
                            <con:flow/>
                        </con:default-branch>
                    </con:branch-table>
                </con:branch-node>`;
      } else if (hasSSF) {
        flow = `
                <con:pipeline-node name="Pipeline Pair NodeSSFDec_${op.operationName}">
                    <con:request>${reqSSFDec}</con:request>
                    <con:response>${resSSFEnc}</con:response>
                </con:pipeline-node>
                <con:branch-node type="condition" id="${id()}" name="ValidateBranch_${op.operationName}">
                    <con:context/>
                    <con:branch-table variable="validate">
                        <con:branch name="SSF">
                            <con:operator>equals</con:operator>
                            <con:value>'SSF'</con:value>
                            <con:flow>
                                <con:pipeline-node name="Pipeline Pair NodeSSFOam_${op.operationName}">
                                    <con:request>${reqSSFOam}</con:request>
                                    <con:response>${resSSFOam}</con:response>
                                </con:pipeline-node>
                                <con:pipeline-node name="Pipeline Pair NodeSSFPartner_${op.operationName}">
                                    <con:request>${reqSSFPartner}</con:request>
                                    <con:response>${resSSFPartner}</con:response>
                                </con:pipeline-node>
                                ${routeNode}
                            </con:flow>
                        </con:branch>
                        <con:default-branch>
                            <con:flow/>
                        </con:default-branch>
                    </con:branch-table>
                </con:branch-node>`;
      } else if (hasB2B) {
        flow = `
                <con:pipeline-node name="Pipeline Pair Node8_${op.operationName}">
                    <con:request>${reqB2BAccess}</con:request>
                    <con:response>${resB2BEnc}</con:response>
                </con:pipeline-node>
                <con:pipeline-node name="Pipeline Pair Node9_${op.operationName}">
                    <con:request>${reqB2BOam}</con:request>
                    <con:response>${resB2BOam}</con:response>
                </con:pipeline-node>
                ${routeNode}`;
      } else {
        flow = routeNode;
      }
    }

    return { pipelines, flow };
  };

  // ─── Generate per-op data ───
  const perOpData = ops.map(op => generatePerOpPipelines(op));
  const allPerOpPipelines = perOpData.map(d => d.pipelines).join('\n');

  // ─── Build the main output ───
  return `<?xml version="1.0" encoding="UTF-8"?>
<con:pipelineEntry xmlns:con="http://www.bea.com/wli/sb/pipeline/config" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:con2="http://www.bea.com/wli/sb/stages/logging/config" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
    <con:coreEntry>
        <con:binding type="SOAP" isSoap12="false" xsi:type="con:SoapBindingType">
            <con:wsdl ref="${projectName}/wsdl/${serviceName}"/>
            <con:binding>
                <con:name>${psName}_ptt-binding</con:name>
                <con:namespace>${psNs}</con:namespace>
            </con:binding>
        </con:binding>
        <con:xqConfiguration>
            <con:snippetVersion>1.0</con:snippetVersion>
        </con:xqConfiguration>
    </con:coreEntry>
    <con:router>
        ${allPerOpPipelines}
        <con:pipeline type="request" name="${reqGlobal}">
            <con:stage id="${sid()}" name="GloabalVariableStage" xmlns:con3="http://www.bea.com/wli/sb/stages/config">
                <con:context>
                    <con3:userNsDecl prefix="v2" namespace="${namespace}"/>
                </con:context>
                <con:actions>
                    <con1:assign varName="OriginalMessage" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$body</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con2:log>
                        <con3:id>${id()}</con3:id>
                        <con2:logLevel>debug</con2:logLevel>
                        <con2:expr><con3:xqueryText>$body</con3:xqueryText></con2:expr>
                        <con2:message><![CDATA[<<<<<${projectName}|${serviceName}|OriginalInput>>>>>]]></con2:message>
                    </con2:log>
                    <con1:assign varName="compositeName" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>"${psName}"</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:assign varName="headerAuthorizationValue" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$inbound/ctx:transport/ctx:request/tp:headers/tp:user-header[fn:lower-case(@name)='authorization']/@value</con3:xqueryText></con1:expr>
                    </con1:assign>
                    <con1:assign varName="operationVar" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>$inbound/ctx:service/ctx:operation/text()</con3:xqueryText></con1:expr>
                    </con1:assign>
                    ${(hasMobility || hasB2B) ? `<con1:assign varName="subSource" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>if (empty($body/*/v2:SubSource))
then "Mobility"
else $body/*/v2:SubSource/text()</con3:xqueryText></con1:expr>
                    </con1:assign>` : ""}
                    ${multiChannel ? `<con1:assign varName="channelType" xmlns:con1="http://www.bea.com/wli/sb/stages/transform/config">
                        <con3:id>${id()}</con3:id>
                        <con1:expr><con3:xqueryText>${(() => {
                          if (hasSSF && hasMobility && hasB2B) {
                            return `if (fn:exists($body//*:SSFPartnerLoginId/text())) then "SSF"
else if (empty($body/*/v2:SubSource) or $body/*/v2:SubSource/text() = 'Mobility') then "Mobility"
else "B2B"`;
                          } else if (hasSSF && hasMobility) {
                            return `if (fn:exists($body//*:SSFPartnerLoginId/text())) then "SSF" else "Mobility"`;
                          } else if (hasSSF && hasB2B) {
                            return `if (fn:exists($body//*:SSFPartnerLoginId/text())) then "SSF" else "B2B"`;
                          } else if (hasMobility && hasB2B) {
                            return `if (empty($body/*/v2:SubSource) or $body/*/v2:SubSource/text() = 'Mobility')
then "Mobility"
else "B2B"`;
                          }
                          return `"${hasSSF ? 'SSF' : hasMobility ? 'Mobility' : 'B2B'}"`;
                        })()}</con3:xqueryText></con1:expr>
                    </con1:assign>` : ""}
                </con:actions>
            </con:stage>
        </con:pipeline>
        <con:pipeline type="response" name="${resGlobal}"/>
        <con:flow>
            <con:pipeline-node name="Pipeline Pair Node1">
                <con:request>${reqGlobal}</con:request>
                <con:response>${resGlobal}</con:response>
            </con:pipeline-node>
            <con:branch-node type="operation" id="${id()}" name="OperationBranchNode">
                <con:context/>
                <con:branch-table>
${ops.map((op, i) => `                    <con:branch name="${op.operationName}">
                        <con:operator>equals</con:operator>
                        <con:value/>
                        <con:flow>
                            ${perOpData[i].flow}
                        </con:flow>
                    </con:branch>`).join('\n')}
                    <con:default-branch>
                        <con:flow/>
                    </con:default-branch>
                </con:branch-table>
            </con:branch-node>
        </con:flow>
    </con:router>
</con:pipelineEntry>`;
}


// ─── JSON TO FIELDS PARSER ───────────────────────────────────
function jsonToFields(json) {
  try {
    const obj = typeof json === "string" ? JSON.parse(json) : json;
    if (typeof obj !== "object" || obj === null) return null;
    return Object.entries(obj).map(([key, val]) => {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        const children = Object.keys(val[0]).map(ck => ({
          name: ck, type: "string", optional: true, odsMapping: "", siebelMapping: ""
        }));
        return { name: key, type: "string", optional: true, isList: true, isGroup: false, children, odsMapping: "", siebelMapping: "", odsItemName: "" };
      }
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        // Check for wrapper+array pattern: { "Wrapper": { "Item": [{...}] } } → treat as LIST
        const entries = Object.entries(val);
        const arrEntry = entries.find(([_, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null);
        if (arrEntry) {
          const [itemName, items] = arrEntry;
          const children = Object.keys(items[0]).map(ck => ({
            name: ck, type: "string", optional: true, odsMapping: "", siebelMapping: ""
          }));
          return { name: key, type: "string", optional: true, isList: true, isGroup: false, children, odsMapping: "", siebelMapping: "", odsItemName: itemName };
        }
        // Pure nested object → GROUP
        const children = jsonToFields(val);
        return { name: key, type: "string", optional: true, isList: false, isGroup: true, children: children || [], odsMapping: "", siebelMapping: "" };
      }
      return { name: key, type: "string", optional: true, isList: false, isGroup: false, children: [], odsMapping: "", siebelMapping: "" };
    });
  } catch { return null; }
}

// ─── ODS SAMPLE PARSER ──────────────────────────────────────
function parseOdsSample(text) {
  if (!text?.trim()) return null;
  // Try JSON
  try {
    const obj = JSON.parse(text.trim());
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      return { fields: extractOdsFieldsFromJson(obj), elementName: null, serviceId: null };
    }
  } catch {}
  // Try XML
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text.trim(), "text/xml");
    if (!doc.querySelector("parsererror")) {
      return extractOdsFieldsFromXml(doc.documentElement);
    }
  } catch {}
  return null;
}

function extractOdsFieldsFromJson(obj) {
  const fields = [];
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
      const children = Object.keys(val[0]);
      fields.push({ name: key, isList: true, wrapper: key, itemName: key, children });
    } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const entries = Object.entries(val);
      const arrEntry = entries.find(([_, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object");
      if (arrEntry) {
        const [itemName, items] = arrEntry;
        const children = Object.keys(items[0]);
        fields.push({ name: key, isList: true, wrapper: key, itemName, children });
      } else {
        const children = Object.keys(val);
        fields.push({ name: key, isList: false, isGroup: true, children });
      }
    } else {
      fields.push({ name: key, isList: false });
    }
  }
  return fields;
}

function extractOdsFieldsFromXml(rootEl) {
  let payloadEl = rootEl;
  let elementName = null;
  let serviceId = null;
  const rootName = rootEl.localName;

  // Detect InputParameters wrapper: drill into IP_INPUT_XML's child element
  if (rootName === "InputParameters") {
    for (const child of rootEl.children) {
      if (child.localName === "IP_SERVICE_ID") {
        serviceId = child.textContent?.trim() || null;
      }
      if (child.localName === "IP_INPUT_XML" && child.children.length > 0) {
        payloadEl = child.children[0]; // The actual ODS request element
        elementName = payloadEl.localName;
      }
    }
  }
  // Detect OutputParameters wrapper: drill into OP_OUTPUT_XML's child element
  else if (rootName === "OutputParameters") {
    for (const child of rootEl.children) {
      if (child.localName === "OP_OUTPUT_XML" && child.children.length > 0) {
        payloadEl = child.children[0]; // The actual ODS response element
        elementName = payloadEl.localName;
      }
    }
  }
  // Direct ODS element (no wrapper) — use root element name
  else {
    elementName = rootName;
  }

  const fields = [];
  const childMap = {};
  for (const child of payloadEl.children) {
    const name = child.localName;
    if (!childMap[name]) childMap[name] = [];
    childMap[name].push(child);
  }
  for (const [name, elements] of Object.entries(childMap)) {
    const first = elements[0];
    if (first.children.length > 0) {
      const subChildren = Array.from(first.children);
      const subGroups = {};
      for (const sc of subChildren) {
        if (!subGroups[sc.localName]) subGroups[sc.localName] = [];
        subGroups[sc.localName].push(sc);
      }
      let foundList = false;
      for (const [subName, subEls] of Object.entries(subGroups)) {
        if (subEls[0].children.length > 0 || subEls.length > 1) {
          const itemChildren = subEls[0].children.length > 0
            ? Array.from(subEls[0].children).map(c => c.localName)
            : [];
          fields.push({ name, isList: true, wrapper: name, itemName: subName, children: itemChildren });
          foundList = true;
          break;
        }
      }
      if (!foundList) {
        const children = Object.keys(subGroups);
        fields.push({ name, isList: false, isGroup: true, children });
      }
    } else {
      fields.push({ name, isList: false });
    }
  }
  return { fields, elementName, serviceId };
}

function normalizeFieldName(name) {
  return name.replace(/_spc/g, "").replace(/_/g, "").toLowerCase();
}

// Split a field name into lowercase tokens for fuzzy matching
// "MobileNumber" → ["mobile","number"], "FUEL_TYPE" → ["fuel","type"], "Error_spcCode" → ["error","code"]
function tokenize(name) {
  return name
    .replace(/_spc/g, "_")                   // Siebel space marker → underscore
    .replace(/([a-z])([A-Z])/g, "$1_$2")     // camelCase split
    .split(/[_\s]+/)                          // split on underscores/spaces
    .map(t => t.toLowerCase())
    .filter(Boolean);
}

// Common abbreviation pairs (bidirectional)
const ABBREVIATIONS = [
  ["num", "number"], ["id", "identifier"], ["msg", "message"], ["desc", "description"],
  ["addr", "address"], ["amt", "amount"], ["qty", "quantity"], ["dt", "date"],
  ["ph", "phone"], ["mob", "mobile"], ["tel", "telephone"], ["fname", "firstname"],
  ["lname", "lastname"], ["dob", "dateofbirth"], ["txn", "transaction"], ["trx", "transaction"],
  ["acct", "account"], ["acc", "account"], ["cust", "customer"], ["prod", "product"],
  ["cat", "category"], ["stat", "status"], ["src", "source"], ["dest", "destination"],
  ["req", "request"], ["res", "response"], ["err", "error"], ["info", "information"],
  ["ref", "reference"], ["svc", "service"], ["loc", "location"], ["org", "organization"],
];

// Expand a token to include its abbreviation counterpart
function expandToken(token) {
  const expansions = [token];
  for (const [a, b] of ABBREVIATIONS) {
    if (token === a) expansions.push(b);
    if (token === b) expansions.push(a);
  }
  return expansions;
}

// Score how well two field names match (0 = no match, higher = better)
function fieldSimilarity(appName, targetName) {
  // Exact match (case-insensitive, strip _spc and _)
  const normA = normalizeFieldName(appName);
  const normB = normalizeFieldName(targetName);
  if (normA === normB) return 100;

  // Tokenized matching
  const tokensA = tokenize(appName);
  const tokensB = tokenize(targetName);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Count how many tokens from A match tokens in B (with abbreviation expansion)
  let matchedA = 0;
  let matchedB = new Set();
  for (const ta of tokensA) {
    const expanded = expandToken(ta);
    for (let bi = 0; bi < tokensB.length; bi++) {
      if (matchedB.has(bi)) continue;
      const expandedB = expandToken(tokensB[bi]);
      if (expanded.some(ea => expandedB.includes(ea))) {
        matchedA++;
        matchedB.add(bi);
        break;
      }
    }
  }

  if (matchedA === 0) return 0;

  // Score: proportion of matched tokens from both sides
  const coverageA = matchedA / tokensA.length;
  const coverageB = matchedB.size / tokensB.length;
  const score = (coverageA + coverageB) / 2 * 80; // max 80 for token match

  // Bonus for token order preserved
  if (matchedA >= 2 && tokensA.length === tokensB.length && matchedA === tokensA.length) {
    return score + 15; // near-perfect match with abbreviation expansion
  }

  return score;
}

// Find the best match for an app field name among target field names
// Returns { name, score } or null if no good match
function findBestMatch(appName, targetNames, threshold = 35) {
  let best = null;
  let bestScore = 0;
  for (const tn of targetNames) {
    const score = fieldSimilarity(appName, tn);
    if (score > bestScore) {
      bestScore = score;
      best = tn;
    }
  }
  return bestScore >= threshold ? { name: best, score: bestScore } : null;
}

// Walk DOM tree to find child elements by local name, namespace-safe
function findChildByLocalName(el, localName) {
  for (const child of el.childNodes) {
    if (child.nodeType === 1 && child.localName === localName) return child;
  }
  return null;
}

// Extract field names from inside a Siebel WSDL's _Input and _Output complexTypes
function extractSiebelWsdlFields(xml) {
  try {
    let fixedXml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, "&amp;");
    const parser = new DOMParser();
    let doc = parser.parseFromString(fixedXml, "text/xml");
    // If broken, strip <service> block (often has malformed URLs) and retry
    if (doc.getElementsByTagName("parsererror").length > 0) {
      fixedXml = fixedXml.replace(/<service[\s\S]*?<\/service>/gi, "");
      doc = parser.parseFromString(fixedXml, "text/xml");
    }
    if (doc.getElementsByTagName("parsererror").length > 0) {
      return { inputFields: [], outputFields: [] };
    }

    const XSD_NS = "http://www.w3.org/2001/XMLSchema";

    // Get all <xsd:element> using namespace-aware method (works regardless of prefix)
    const allElements = [...doc.getElementsByTagNameNS(XSD_NS, "element")];
    let inputTypeName = "", outputTypeName = "";

    for (const el of allElements) {
      const name = el.getAttribute("name") || "";
      if (name.endsWith("_Input") && !inputTypeName) inputTypeName = name;
      if (name.endsWith("_Output") && !outputTypeName) outputTypeName = name;
    }

    const inputFields = [];
    const outputFields = [];

    // Find a root element by name, then walk: element > complexType > sequence > element children
    const findFieldsUnder = (rootName, fieldList) => {
      for (const el of allElements) {
        const name = el.getAttribute("name") || "";
        if (name !== rootName) continue;

        // Navigate: root element → complexType → sequence → child elements
        const complexType = findChildByLocalName(el, "complexType");
        if (!complexType) continue;
        const sequence = findChildByLocalName(complexType, "sequence");
        if (!sequence) continue;

        // Iterate direct children of <sequence> that are <element>
        for (const child of sequence.childNodes) {
          if (child.nodeType !== 1 || child.localName !== "element") continue;
          const childName = child.getAttribute("name");
          if (!childName) continue;

          const maxOccurs = child.getAttribute("maxOccurs") || "";
          // Check if this element has its own complexType (making it a list/nested structure)
          const nestedComplex = findChildByLocalName(child, "complexType");

          if (maxOccurs === "unbounded" && nestedComplex) {
            // List element — extract its child fields from nested sequence
            const nestedSeq = findChildByLocalName(nestedComplex, "sequence");
            const children = [];
            if (nestedSeq) {
              for (const nested of nestedSeq.childNodes) {
                if (nested.nodeType === 1 && nested.localName === "element") {
                  const nn = nested.getAttribute("name");
                  if (nn) children.push(nn);
                }
              }
            }
            fieldList.push({ name: childName, isList: true, children });
          } else {
            fieldList.push({ name: childName, isList: false });
          }
        }
        if (fieldList.length > 0) return;
      }
    };

    if (inputTypeName) findFieldsUnder(inputTypeName, inputFields);
    if (outputTypeName) findFieldsUnder(outputTypeName, outputFields);

    return { inputFields, outputFields };
  } catch (e) {
    console.error("WSDL parse error:", e);
    return { inputFields: [], outputFields: [] };
  }
}

// Helper: get flat field name from structured WSDL field (string or {name})
function siebelFieldName(sf) {
  return typeof sf === "string" ? sf : sf.name;
}

// Helper: get all flat WSDL field names for dropdown/matching
function flatSiebelNames(siebelFields) {
  if (!siebelFields) return [];
  return siebelFields.map(siebelFieldName);
}

// Match app fields to actual Siebel WSDL fields using normalized comparison
function autoMapSiebelFields(appFields, siebelFields) {
  if (!siebelFields || siebelFields.length === 0) return appFields;
  const names = flatSiebelNames(siebelFields);
  return appFields.map(af => {
    if (af.siebelMapping) return af;
    // 1. Exact match
    let match = names.find(sf => sf === af.name);
    // 2. Normalized match
    if (!match) {
      const norm = normalizeFieldName(af.name);
      match = names.find(sf => normalizeFieldName(sf) === norm);
    }
    // 3. Fuzzy/abbreviation match
    if (!match) {
      const best = findBestMatch(af.name, names);
      if (best) match = best.name;
    }
    if (!match) return af;
    const updates = { ...af, siebelMapping: match };
    // If app field is a list and the matching WSDL field is also a list, map children
    if (af.isList && af.children) {
      const wsdlField = siebelFields.find(sf => siebelFieldName(sf) === match);
      if (wsdlField && typeof wsdlField === "object" && wsdlField.isList && wsdlField.children) {
        updates.children = af.children.map(ac => {
          if (ac.siebelMapping) return ac;
          let childMatch = wsdlField.children.find(cn => cn === ac.name)
            || wsdlField.children.find(cn => normalizeFieldName(cn) === normalizeFieldName(ac.name));
          if (!childMatch) {
            const best = findBestMatch(ac.name, wsdlField.children);
            if (best) childMatch = best.name;
          }
          return childMatch ? { ...ac, siebelMapping: childMatch } : ac;
        });
      }
    }
    return updates;
  });
}

function autoMapFields(appFields, odsFields) {
  if (!odsFields || odsFields.length === 0) return appFields;
  const odsNames = odsFields.map(of => of.name);
  return appFields.map(af => {
    if (af.odsMapping) return af;
    // 1. Exact match
    let match = odsFields.find(of => of.name === af.name);
    // 2. Normalized match
    if (!match) {
      const norm = normalizeFieldName(af.name);
      match = odsFields.find(of => normalizeFieldName(of.name) === norm);
    }
    // 3. Fuzzy/abbreviation match
    if (!match) {
      const best = findBestMatch(af.name, odsNames);
      if (best) match = odsFields.find(of => of.name === best.name);
    }
    if (!match) return af;
    const updates = { ...af, odsMapping: match.name };
    if (af.isList && match.isList) {
      updates.odsMapping = match.wrapper;
      updates.odsItemName = match.itemName;
      if (match.children && af.children) {
        updates.children = af.children.map(ac => {
          if (ac.odsMapping) return ac;
          // Try exact, normalized, then fuzzy for children too
          let childMatch = match.children.find(cn => cn === ac.name)
            || match.children.find(cn => normalizeFieldName(cn) === normalizeFieldName(ac.name));
          if (!childMatch) {
            const best = findBestMatch(ac.name, match.children);
            if (best) childMatch = best.name;
          }
          return childMatch ? { ...ac, odsMapping: childMatch } : ac;
        });
      }
    }
    if (af.isGroup && match.isGroup && match.children && af.children) {
      updates.children = af.children.map(ac => {
        if (ac.odsMapping) return ac;
        let childMatch = match.children.find(cn => cn === ac.name)
          || match.children.find(cn => normalizeFieldName(cn) === normalizeFieldName(ac.name));
        if (!childMatch) {
          const best = findBestMatch(ac.name, match.children);
          if (best) childMatch = best.name;
        }
        return childMatch ? { ...ac, odsMapping: childMatch } : ac;
      });
    }
    return updates;
  });
}

// ─── FIELD EDITOR COMPONENT ─────────────────────────────────
function FieldEditor({ fields, setFields, label, showOdsMapping, showSiebelMapping, odsSuggestions }) {
  const addField = () => setFields([...fields, { name: "", type: "string", optional: false, isList: false, children: [], odsMapping: "", siebelMapping: "" }]);
  const removeField = (i) => setFields(fields.filter((_, idx) => idx !== i));
  const updateField = (i, key, val) => {
    const nf = [...fields];
    nf[i] = { ...nf[i], [key]: val };
    setFields(nf);
  };
  const addChild = (i) => {
    const nf = [...fields];
    nf[i].children = [...(nf[i].children || []), { name: "", type: "string", optional: false, odsMapping: "", siebelMapping: "" }];
    setFields(nf);
  };
  const removeChild = (fi, ci) => {
    const nf = [...fields];
    nf[fi].children = nf[fi].children.filter((_, idx) => idx !== ci);
    setFields(nf);
  };
  const updateChild = (fi, ci, key, val) => {
    const nf = [...fields];
    nf[fi].children[ci] = { ...nf[fi].children[ci], [key]: val };
    setFields(nf);
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#a3a3a3" }}>{label}</span>
        <button onClick={addField} style={{ background: "#d4d4d4", color: "#0a0a0a", border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>+ Field</button>
      </div>
      {fields.map((f, i) => (
        <div key={i} style={{ background: "#1c1c1c", borderRadius: 8, padding: 12, marginBottom: 8, border: "1px solid #333333" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input placeholder="Field name" value={f.name} onChange={e => updateField(i, "name", e.target.value)}
              style={{ flex: 1, minWidth: 120, background: "#141414", border: "1px solid #404040", borderRadius: 6, padding: "6px 10px", color: "#e5e5e5", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }} />
            <select value={f.type} onChange={e => updateField(i, "type", e.target.value)}
              style={{ background: "#141414", border: "1px solid #404040", borderRadius: 6, padding: "6px 10px", color: "#e5e5e5", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
              <option value="string">string</option>
              <option value="int">int</option>
              <option value="decimal">decimal</option>
              <option value="boolean">boolean</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#a3a3a3", cursor: "pointer" }}>
              <input type="checkbox" checked={f.optional} onChange={e => updateField(i, "optional", e.target.checked)} /> Opt
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#a3a3a3", cursor: "pointer" }}>
              <input type="checkbox" checked={f.isList} onChange={e => { updateField(i, "isList", e.target.checked); if (e.target.checked) updateField(i, "isGroup", false); }} /> List
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#a3a3a3", cursor: "pointer" }}>
              <input type="checkbox" checked={f.isGroup || false} onChange={e => { updateField(i, "isGroup", e.target.checked); if (e.target.checked) updateField(i, "isList", false); }} /> Group
            </label>
            {showOdsMapping && (
              <>
                <input list={`ods-${label}-${i}`} placeholder="ODS mapping" value={f.odsMapping || ""} onChange={e => updateField(i, "odsMapping", e.target.value)}
                  style={{ width: 120, background: "#141414", border: "1px solid #404040", borderRadius: 6, padding: "6px 10px", color: f.odsMapping ? "#e5e5e5" : "#b3b3b3", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                {odsSuggestions && odsSuggestions.length > 0 && (
                  <datalist id={`ods-${label}-${i}`}>
                    {odsSuggestions.map(s => <option key={s.name} value={s.name} />)}
                  </datalist>
                )}
              </>
            )}
            {showSiebelMapping && (
              <input placeholder="Siebel mapping" value={f.siebelMapping || ""} onChange={e => updateField(i, "siebelMapping", e.target.value)}
                style={{ width: 120, background: "#141414", border: "1px solid #404040", borderRadius: 6, padding: "6px 10px", color: "#b3b3b3", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
            )}
            <button onClick={() => removeField(i)} style={{ background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, width: 28, height: 28, fontSize: 14, cursor: "pointer", fontWeight: 700 }}>×</button>
          </div>
          {(f.isList || f.isGroup) && (
            <div style={{ marginTop: 8, marginLeft: 24, borderLeft: `2px solid ${f.isGroup ? "#4a7a9a" : "#525252"}`, paddingLeft: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#d4d4d4", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{f.isGroup ? "Group Fields" : "Child Fields"}</span>
                {f.isList && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input list={`ods-item-${label}-${i}`} placeholder="ODS item name" value={f.odsItemName || ""} onChange={e => updateField(i, "odsItemName", e.target.value)}
                      style={{ width: 110, background: "#141414", border: "1px solid #404040", borderRadius: 4, padding: "3px 6px", color: f.odsItemName ? "#e5e5e5" : "#b3b3b3", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }} />
                    {odsSuggestions && (() => {
                      const matchedList = odsSuggestions.find(s => s.isList && (s.name === f.odsMapping || s.wrapper === f.odsMapping));
                      if (!matchedList) return null;
                      return (<datalist id={`ods-item-${label}-${i}`}><option value={matchedList.itemName} /></datalist>);
                    })()}
                    <button onClick={() => addChild(i)} style={{ background: "#a3a3a3", color: "#0a0a0a", border: "none", borderRadius: 4, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>+ Child</button>
                  </div>
                )}
                {f.isGroup && (
                  <button onClick={() => addChild(i)} style={{ background: "#a3a3a3", color: "#0a0a0a", border: "none", borderRadius: 4, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>+ Child</button>
                )}
              </div>
              {(f.children || []).map((c, ci) => (
                <div key={ci} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <input placeholder="Child field" value={c.name} onChange={e => updateChild(i, ci, "name", e.target.value)}
                    style={{ flex: 1, background: "#141414", border: "1px solid #404040", borderRadius: 4, padding: "4px 8px", color: "#e5e5e5", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                  {showOdsMapping && (
                    <>
                      <input list={`ods-child-${label}-${i}-${ci}`} placeholder="ODS name" value={c.odsMapping || ""} onChange={e => updateChild(i, ci, "odsMapping", e.target.value)}
                        style={{ width: 100, background: "#141414", border: "1px solid #404040", borderRadius: 4, padding: "4px 8px", color: c.odsMapping ? "#e5e5e5" : "#b3b3b3", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                      {odsSuggestions && (() => {
                        const parentOds = odsSuggestions.find(s => s.isList && (s.name === f.odsMapping || s.wrapper === f.odsMapping));
                        if (!parentOds || !parentOds.children) return null;
                        return (<datalist id={`ods-child-${label}-${i}-${ci}`}>{parentOds.children.map(cn => <option key={cn} value={cn} />)}</datalist>);
                      })()}
                    </>
                  )}
                  <button onClick={() => removeChild(i, ci)} style={{ background: "#ef4444", color: "#fff", border: "none", borderRadius: 4, width: 22, height: 22, fontSize: 12, cursor: "pointer" }}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── MAPPING REVIEW COMPONENT ───────────────────────────────
function MappingReview({ requestFields, responseFields, setRequestFields, setResponseFields, serviceType, requestElement, responseElement, siebelInputElement, siebelOutputElement, siebelInputFields, siebelOutputFields }) {
  const targetLabel = serviceType === "ODS" ? "ODS" : "Siebel";
  const mappingKey = serviceType === "ODS" ? "odsMapping" : "siebelMapping";
  const reqTargetEl = serviceType === "ODS" ? requestElement : siebelInputElement;
  const resTargetEl = serviceType === "ODS" ? responseElement : siebelOutputElement;

  const updateMapping = (fields, setFields, fieldIdx, value, childIdx) => {
    const nf = [...fields];
    if (childIdx !== undefined) {
      nf[fieldIdx].children[childIdx] = { ...nf[fieldIdx].children[childIdx], [mappingKey]: value };
    } else {
      nf[fieldIdx] = { ...nf[fieldIdx], [mappingKey]: value };
    }
    setFields(nf);
  };

  const autoSuggestFromWsdl = (fields, setFields, wsdlFields) => {
    if (!wsdlFields || wsdlFields.length === 0) return;
    setFields(autoMapSiebelFields(fields, wsdlFields));
  };

  // Get flat list of WSDL field names (for simple fields) or find list children
  const getWsdlNames = (wsdlFields) => flatSiebelNames(wsdlFields);
  const getWsdlListChildren = (wsdlFields, parentName) => {
    if (!wsdlFields) return [];
    const wf = wsdlFields.find(f => typeof f === "object" && f.name === parentName && f.isList);
    return wf ? wf.children || [] : [];
  };

  const selectStyle = (hasValue) => ({
    background: "#141414", border: "1px solid #404040", borderRadius: 6, padding: "6px 10px",
    color: hasValue ? "#e5e5e5" : "#525252", fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
    width: "100%", boxSizing: "border-box", cursor: "pointer", appearance: "none",
    backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center",
    borderColor: hasValue ? "#404040" : "#4a4a2a"
  });

  const selectStyleSmall = (hasValue) => ({
    ...selectStyle(hasValue), fontSize: 12, padding: "5px 8px",
    border: `1px solid ${hasValue ? "#333333" : "#4a4a2a"}`
  });

  const renderSiebelSelect = (value, onChange, wsdlNames, placeholder) => (
    <select value={value || ""} onChange={e => onChange(e.target.value)} style={selectStyle(!!value)}>
      <option value="" style={{ color: "#525252" }}>{placeholder || "— Select WSDL field —"}</option>
      {wsdlNames.map(wf => <option key={wf} value={wf}>{wf}</option>)}
    </select>
  );

  const renderSiebelSelectSmall = (value, onChange, wsdlNames, placeholder) => (
    <select value={value || ""} onChange={e => onChange(e.target.value)} style={selectStyleSmall(!!value)}>
      <option value="" style={{ color: "#525252" }}>{placeholder || "— Select —"}</option>
      {wsdlNames.map(wf => <option key={wf} value={wf}>{wf}</option>)}
    </select>
  );

  const renderTable = (fields, setFields, label, appElement, targetElement, wsdlFields) => {
    const hasLists = fields.some(f => f.isList && f.children?.length > 0);
    const hasWsdlFields = wsdlFields && wsdlFields.length > 0;
    const wsdlNames = hasWsdlFields ? getWsdlNames(wsdlFields) : [];
    const hasUnmapped = serviceType === "Siebel" && fields.some(f => !f[mappingKey]);
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#a3a3a3" }}>{label}</span>
          {serviceType === "Siebel" && hasWsdlFields && (
            <button onClick={() => autoSuggestFromWsdl(fields, setFields, wsdlFields)}
              style={{ background: "#292929", color: "#d4d4d4", border: "1px solid #404040", borderRadius: 6, padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
              Auto-map from WSDL
            </button>
          )}
        </div>
        <div style={{ background: "#1c1c1c", borderRadius: 10, border: "1px solid #333333", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 40px 1fr", alignItems: "center", padding: "10px 16px", background: "#141414", borderBottom: "1px solid #333333" }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#737373" }}>
              App Field <span style={{ color: "#525252", fontWeight: 400 }}>({appElement})</span>
            </div>
            <div style={{ textAlign: "center", color: "#525252", fontSize: 14 }}></div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#737373" }}>
              {targetLabel} Field <span style={{ color: "#525252", fontWeight: 400 }}>({targetElement})</span>
            </div>
          </div>
          {/* Rows */}
          {fields.map((f, i) => (
            <div key={i}>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 40px 1fr", alignItems: "center",
                padding: "8px 16px", borderBottom: "1px solid #262626",
                background: !f[mappingKey] ? "#1a1a0a" : "transparent"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#e5e5e5", fontWeight: 600 }}>{f.name}</span>
                  {f.isList && <span style={{ fontSize: 9, color: "#0a0a0a", background: "#a3a3a3", borderRadius: 3, padding: "1px 5px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>LIST</span>}
                  {f.isGroup && <span style={{ fontSize: 9, color: "#0a0a0a", background: "#6aa3c9", borderRadius: 3, padding: "1px 5px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>GROUP</span>}
                  {f.optional && <span style={{ fontSize: 9, color: "#737373", fontFamily: "'JetBrains Mono', monospace" }}>opt</span>}
                </div>
                <div style={{ textAlign: "center", color: "#525252", fontSize: 16, fontFamily: "'JetBrains Mono', monospace" }}>→</div>
                <div style={{ width: "100%" }}>
                  {serviceType === "Siebel" && hasWsdlFields
                    ? renderSiebelSelect(f[mappingKey], (val) => updateMapping(fields, setFields, i, val), wsdlNames)
                    : <input
                        value={f[mappingKey] || ""}
                        onChange={e => updateMapping(fields, setFields, i, e.target.value)}
                        placeholder={f.name}
                        style={{
                          background: "#141414", border: "1px solid #404040", borderRadius: 6, padding: "6px 10px",
                          color: f[mappingKey] ? "#e5e5e5" : "#525252", fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
                          width: "100%", boxSizing: "border-box",
                          borderColor: !f[mappingKey] ? "#4a4a2a" : "#404040"
                        }}
                      />
                  }
                </div>
              </div>
              {/* ODS item name for lists */}
              {f.isList && serviceType === "ODS" && (
                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 40px 1fr", alignItems: "center",
                  padding: "6px 16px 6px 28px", borderBottom: "1px solid #1a1a1a",
                  background: "#181818"
                }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#737373", fontStyle: "italic" }}>
                    item element name
                  </div>
                  <div style={{ textAlign: "center", color: "#404040", fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>→</div>
                  <input
                    value={f.odsItemName || ""}
                    onChange={e => { const nf = [...fields]; nf[i] = { ...nf[i], odsItemName: e.target.value }; setFields(nf); }}
                    placeholder={f.name.replace(/List$/, "")}
                    style={{
                      background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "5px 8px",
                      color: f.odsItemName ? "#e5e5e5" : "#525252", fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                      width: "100%", boxSizing: "border-box"
                    }}
                  />
                </div>
              )}
              {/* Child fields for lists */}
              {(f.isList || f.isGroup) && f.children?.map((c, ci) => {
                // For Siebel lists, get the WSDL children of the mapped parent element
                const siebelListChildren = (serviceType === "Siebel" && hasWsdlFields && f[mappingKey])
                  ? getWsdlListChildren(wsdlFields, f[mappingKey])
                  : [];
                return (
                  <div key={ci} style={{
                    display: "grid", gridTemplateColumns: "1fr 40px 1fr", alignItems: "center",
                    padding: "6px 16px 6px 40px", borderBottom: "1px solid #1a1a1a",
                    background: "#161616"
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "#525252", fontSize: 11 }}>└</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#a3a3a3" }}>{c.name}</span>
                    </div>
                    <div style={{ textAlign: "center", color: "#404040", fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>→</div>
                    {serviceType === "Siebel" && siebelListChildren.length > 0
                      ? renderSiebelSelectSmall(c[mappingKey], (val) => updateMapping(fields, setFields, i, val, ci), siebelListChildren, "— Select child —")
                      : <input
                          value={c[mappingKey] || ""}
                          onChange={e => updateMapping(fields, setFields, i, e.target.value, ci)}
                          placeholder={c.name}
                          style={{
                            background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "5px 8px",
                            color: c[mappingKey] ? "#e5e5e5" : "#525252", fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                            width: "100%", boxSizing: "border-box"
                          }}
                        />
                    }
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {/* Legend */}
        {fields.some(f => !f[mappingKey]) && (
          <div style={{ marginTop: 6, fontSize: 10, color: "#737373", fontFamily: "'JetBrains Mono', monospace" }}>
            {serviceType === "Siebel" && hasWsdlFields
              ? "Select WSDL fields from dropdown, or click \"Auto-map from WSDL\" to fill matching names"
              : serviceType === "Siebel"
              ? "Paste Siebel WSDL in Step 1 to enable dropdown selection of WSDL field names"
              : "Fields without a mapping will use the app field name as-is"}
          </div>
        )}
        {/* Show available WSDL fields for reference */}
        {serviceType === "Siebel" && hasWsdlFields && (
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", marginRight: 4 }}>WSDL fields:</span>
            {wsdlFields.map(wf => {
              const wfName = siebelFieldName(wf);
              const isList = typeof wf === "object" && wf.isList;
              const used = fields.some(f => f[mappingKey] === wfName || (f.children || []).some(c => c[mappingKey] === wfName));
              return (
                <span key={wfName} style={{
                  background: used ? "#1a2a1a" : "#1c1c1c", border: `1px solid ${used ? "#2a4a2a" : "#333333"}`,
                  borderRadius: 4, padding: "1px 6px", fontSize: 10,
                  color: used ? "#6a9a6a" : "#737373", fontFamily: "'JetBrains Mono', monospace"
                }}>
                  {wfName}{isList ? " []" : ""}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "#a3a3a3", marginBottom: 4 }}>
          Review how your app fields map to <strong style={{ color: "#d4d4d4" }}>{targetLabel}</strong> fields in the XQuery transformations. Edit any mapping that looks off.
        </div>
      </div>
      {renderTable(requestFields, setRequestFields, "Request Transformation", requestElement, reqTargetEl, serviceType === "Siebel" ? siebelInputFields : null)}
      {renderTable(responseFields, setResponseFields, "Response Transformation", responseElement, resTargetEl, serviceType === "Siebel" ? siebelOutputFields : null)}
    </div>
  );
}

// ─── FILE PREVIEW COMPONENT ─────────────────────────────────
function FilePreview({ files, activeFile, setActiveFile, fileValidation = {} }) {
  if (!files || files.length === 0) return null;
  const current = files.find(f => f.path === activeFile) || files[0];
  const currentVal = fileValidation[current.path];

  return (
    <div style={{ background: "#141414", borderRadius: 12, border: "1px solid #262626", overflow: "hidden" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 0, borderBottom: "1px solid #262626", background: "#0a0a0a" }}>
        {files.map(f => {
          const val = fileValidation[f.path];
          return (
            <button key={f.path} onClick={() => setActiveFile(f.path)}
              style={{
                background: f.path === current.path ? "#1c1c1c" : "transparent",
                color: f.path === current.path ? "#d4d4d4" : "#737373",
                border: "none", borderBottom: f.path === current.path ? "2px solid #d4d4d4" : "2px solid transparent",
                padding: "8px 14px", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer",
                fontWeight: f.path === current.path ? 700 : 400, whiteSpace: "nowrap"
              }}>
              {f.layer === "dmz" && <span style={{ color: "#f59e0b", marginRight: 4, fontSize: 9, fontWeight: 800 }}>DMZ</span>}
              {val && <span style={{ marginRight: 4, fontSize: 9 }}>{val.valid ? "\u2713" : "\u2717"}</span>}
              {f.path.split("/").pop()}
            </button>
          );
        })}
      </div>
      <div style={{ padding: 2 }}>
        <div style={{ fontSize: 10, color: "#525252", padding: "6px 14px", fontFamily: "'JetBrains Mono', monospace", borderBottom: "1px solid #262626", display: "flex", alignItems: "center", gap: 8 }}>
          <span>
            {current.layer === "dmz" && <span style={{ color: "#f59e0b", marginRight: 6, fontWeight: 700 }}>[DMZ]</span>}
            {current.path}
          </span>
          {currentVal && (
            <span style={{ color: currentVal.valid ? "#6a9a6a" : "#ef4444", fontWeight: 700, fontSize: 10 }}>
              {currentVal.valid ? "XML Valid" : "XML Invalid"}
            </span>
          )}
        </div>
        {currentVal && !currentVal.valid && (
          <div style={{ padding: "6px 14px", background: "#1c0a0a", borderBottom: "1px solid #3b1111", fontSize: 10, color: "#ef4444", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.5 }}>
            {currentVal.error}
          </div>
        )}
        <pre style={{
          color: "#e5e5e5", fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
          padding: 14, margin: 0, maxHeight: 500, overflow: "auto", lineHeight: 1.6,
          whiteSpace: "pre-wrap", wordBreak: "break-all"
        }}>
          {current.content}
        </pre>
      </div>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────
// ─── INFO POPUP COMPONENT ─────────────────────────────────
function InfoTooltip({ children, title }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (show) {
      const onKey = e => { if (e.key === "Escape") setShow(false); };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
  }, [show]);

  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <span onClick={() => setShow(true)}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", background: "#262626", border: "1px solid #404040", color: "#737373", fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", lineHeight: 1, marginLeft: 6, userSelect: "none", transition: "all 0.15s" }}>
        i
      </span>
      {show && (
        <div onClick={() => setShow(false)} style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#1a1a1a", border: "1px solid #404040", borderRadius: 12, padding: 0, width: "90%", maxWidth: 500, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.7)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid #333" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#d4d4d4", fontFamily: "'JetBrains Mono', monospace" }}>{title || "Reference"}</span>
              <span onClick={() => setShow(false)} style={{ cursor: "pointer", color: "#737373", fontSize: 18, lineHeight: 1, padding: "0 4px", borderRadius: 4, transition: "color 0.15s" }}>&times;</span>
            </div>
            <div style={{ padding: 18, overflowY: "auto", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#b3b3b3", lineHeight: 1.7 }}>
              {children}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

export default function OSBServiceGenerator() {
  const [scenario, setScenario] = useState(1);
  // Project-level state
  const [projectName, setProjectName] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [proxyName, setProxyName] = useState("");
  const [bindingName, setBindingName] = useState("");
  const [portTypeName, setPortTypeName] = useState("");
  const [environment, setEnvironment] = useState("UAT");
  const [uriPath, setUriPath] = useState("");
  const [authUsers, setAuthUsers] = useState(["dmz_user"]);
  const [customAuth, setCustomAuth] = useState("");
  const [generatedFiles, setGeneratedFiles] = useState([]);
  const [activeFile, setActiveFile] = useState("");
  const [fileValidation, setFileValidation] = useState({}); // { [path]: { valid, error } }
  const [generatedEnv, setGeneratedEnv] = useState("UAT"); // env at generation time
  const [step, setStep] = useState(1);
  const [manualEdits, setManualEdits] = useState({});

  // DMZ Layer state
  const [dmzEnabled, setDmzEnabled] = useState(false);
  const [dmzChannels, setDmzChannels] = useState({ mobility: true, b2b: false, ssf: false });
  const [dmzDvmKey, setDmzDvmKey] = useState("");
  const [dmzAppLayerUrl, setDmzAppLayerUrl] = useState("");
  const [dmzNxsdName, setDmzNxsdName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDmzAdvanced, setShowDmzAdvanced] = useState(false);

  // Operations state (per-operation data)
  const [operations, setOperations] = useState([createDefaultOp()]);
  const [activeOpIdx, setActiveOpIdx] = useState(0);
  const activeOpIdxRef = useRef(0);
  useEffect(() => { activeOpIdxRef.current = activeOpIdx; }, [activeOpIdx]);

  // Update a field on the active operation (uses ref so it's stable for useCallback captures)
  const updateOp = useCallback((field, valueOrFn) => {
    setOperations(prev => prev.map((o, i) => {
      if (i !== activeOpIdxRef.current) return o;
      const newVal = typeof valueOrFn === 'function' ? valueOrFn(o[field]) : valueOrFn;
      return { ...o, [field]: newVal };
    }));
  }, []);

  // Active operation convenience accessor
  const op = operations[activeOpIdx] || operations[0];

  // Backward-compatible getters (so existing UI code keeps working)
  const serviceType = op.serviceType;
  const operationName = op.operationName;
  const requestElement = op.requestElement;
  const responseElement = op.responseElement;
  const requestFields = op.requestFields;
  const responseFields = op.responseFields;
  const odsServiceId = op.odsServiceId;
  const odsRequestElement = op.odsRequestElement;
  const odsResponseElement = op.odsResponseElement;
  const siebelWsdlRef = op.siebelWsdlRef;
  const siebelInputElement = op.siebelInputElement;
  const siebelOutputElement = op.siebelOutputElement;
  const siebelPortName = op.siebelPortName;
  const siebelEndpointUrl = op.siebelEndpointUrl;
  const siebelWsdlRaw = op.siebelWsdlRaw;
  const siebelWsdlParsed = op.siebelWsdlParsed;
  const siebelInputFields = op.siebelInputFields;
  const siebelOutputFields = op.siebelOutputFields;
  const odsRequestSample = op.odsRequestSample;
  const odsResponseSample = op.odsResponseSample;
  const parsedOdsReqFields = op.parsedOdsReqFields;
  const parsedOdsResFields = op.parsedOdsResFields;

  // Backward-compatible setters (delegate to updateOp)
  const setServiceType = (v) => updateOp('serviceType', v);
  const setOperationName = (v) => updateOp('operationName', v);
  const setRequestElement = (v) => updateOp('requestElement', v);
  const setResponseElement = (v) => updateOp('responseElement', v);
  const setRequestFields = (v) => updateOp('requestFields', v);
  const setResponseFields = (v) => updateOp('responseFields', v);
  const setOdsServiceId = (v) => updateOp('odsServiceId', v);
  const setOdsRequestElement = (v) => updateOp('odsRequestElement', v);
  const setOdsResponseElement = (v) => updateOp('odsResponseElement', v);
  const setSiebelWsdlRef = (v) => updateOp('siebelWsdlRef', v);
  const setSiebelInputElement = (v) => updateOp('siebelInputElement', v);
  const setSiebelOutputElement = (v) => updateOp('siebelOutputElement', v);
  const setSiebelPortName = (v) => updateOp('siebelPortName', v);
  const setSiebelEndpointUrl = (v) => updateOp('siebelEndpointUrl', v);
  const setSiebelWsdlRaw = (v) => updateOp('siebelWsdlRaw', v);
  const setSiebelWsdlParsed = (v) => updateOp('siebelWsdlParsed', v);
  const setSiebelInputFields = (v) => updateOp('siebelInputFields', v);
  const setSiebelOutputFields = (v) => updateOp('siebelOutputFields', v);
  const setOdsRequestSample = (v) => updateOp('odsRequestSample', v);
  const setOdsResponseSample = (v) => updateOp('odsResponseSample', v);
  const setParsedOdsReqFields = (v) => updateOp('parsedOdsReqFields', v);
  const setParsedOdsResFields = (v) => updateOp('parsedOdsResFields', v);

  // Operations management
  const addOperation = () => {
    setOperations(prev => [...prev, createDefaultOp()]);
    setActiveOpIdx(operations.length);
  };
  const removeOperation = (idx) => {
    if (operations.length <= 1) return;
    setOperations(prev => prev.filter((_, i) => i !== idx));
    setActiveOpIdx(prev => prev >= idx && prev > 0 ? prev - 1 : prev);
  };

  // markManual routes per-op fields to op.manualEdits, project fields to global manualEdits
  const OP_MANUAL_FIELDS = ['operationName', 'requestElement', 'responseElement'];
  const markManual = (field) => {
    if (OP_MANUAL_FIELDS.includes(field)) {
      setOperations(prev => prev.map((o, i) => i === activeOpIdxRef.current
        ? { ...o, manualEdits: { ...o.manualEdits, [field]: true } }
        : o));
    } else {
      setManualEdits(prev => ({ ...prev, [field]: true }));
    }
  };

  // Auto-derive project-level names from serviceName
  useEffect(() => {
    if (serviceName) {
      if (!manualEdits.proxyName) setProxyName(`${serviceName}PS`);
      if (!manualEdits.bindingName) setBindingName(`${serviceName}Binding`);
      if (!manualEdits.portTypeName) setPortTypeName(`${serviceName}Port`);
      if (!manualEdits.uriPath) setUriPath(`/CRMNex${(ENV_CONFIG[environment] || ENV_CONFIG.UAT).uriEnvCode}Ext/${serviceName}`);
      if (!manualEdits.dmzDvmKey) {
        const dvmSuffix = dmzChannels.mobility ? "Mobility" : dmzChannels.b2b ? "B2B" : dmzChannels.ssf ? "SSF" : "Mobility";
        setDmzDvmKey(`${serviceName}_${dvmSuffix}`);
      }
      if (!manualEdits.dmzNxsdName) setDmzNxsdName(`nxsd_${serviceName}`);
      if (!manualEdits.dmzAppLayerUrl) { const ec = ENV_CONFIG[environment] || ENV_CONFIG.UAT; setDmzAppLayerUrl(`${ec.appLayerBaseUrl}/CRMNex${ec.uriEnvCode}Ext/${serviceName}`); }
      // Auto-derive first operation's names from serviceName
      setOperations(prev => prev.map((o, i) => {
        if (i !== 0) return o;
        const updates = {};
        if (!o.manualEdits?.operationName) updates.operationName = serviceName;
        const opName = updates.operationName || o.operationName;
        if (!o.manualEdits?.requestElement) updates.requestElement = `${opName}Request`;
        if (!o.manualEdits?.responseElement) updates.responseElement = `${opName}Response`;
        return Object.keys(updates).length > 0 ? { ...o, ...updates } : o;
      }));
    } else {
      if (!manualEdits.proxyName) setProxyName("");
      if (!manualEdits.bindingName) setBindingName("");
      if (!manualEdits.portTypeName) setPortTypeName("");
      if (!manualEdits.uriPath) setUriPath("");
      if (!manualEdits.dmzDvmKey) setDmzDvmKey("");
      if (!manualEdits.dmzNxsdName) setDmzNxsdName("");
      if (!manualEdits.dmzAppLayerUrl) setDmzAppLayerUrl("");
      setOperations(prev => prev.map((o, i) => {
        if (i !== 0) return o;
        const updates = {};
        if (!o.manualEdits?.operationName) updates.operationName = "";
        if (!o.manualEdits?.requestElement) updates.requestElement = "";
        if (!o.manualEdits?.responseElement) updates.responseElement = "";
        return Object.keys(updates).length > 0 ? { ...o, ...updates } : o;
      }));
    }
  }, [serviceName, dmzChannels]);

  // Auto-update DVM key when channels change
  useEffect(() => {
    if (serviceName && !manualEdits.dmzDvmKey) {
      const dvmSuffix = dmzChannels.mobility ? "Mobility" : dmzChannels.b2b ? "B2B" : dmzChannels.ssf ? "SSF" : "Mobility";
      setDmzDvmKey(`${serviceName}_${dvmSuffix}`);
    }
  }, [dmzChannels]);

  // Auto-derive requestElement/responseElement when operationName changes (for any op)
  useEffect(() => {
    if (operationName) {
      setOperations(prev => prev.map((o, i) => {
        if (i !== activeOpIdx) return o;
        const updates = {};
        if (!o.manualEdits?.requestElement) updates.requestElement = `${operationName}Request`;
        if (!o.manualEdits?.responseElement) updates.responseElement = `${operationName}Response`;
        return Object.keys(updates).length > 0 ? { ...o, ...updates } : o;
      }));
    }
  }, [operationName, activeOpIdx]);

  useEffect(() => {
    if (serviceName && !manualEdits.uriPath) {
      setUriPath(`/CRMNex${(ENV_CONFIG[environment] || ENV_CONFIG.UAT).uriEnvCode}Ext/${serviceName}`);
    }
    // Update siebelEndpointUrl for ALL operations when environment changes
    if (SIEBEL_ENDPOINTS[environment]) {
      setOperations(prev => prev.map(o => ({ ...o, siebelEndpointUrl: SIEBEL_ENDPOINTS[environment] })));
    }
  }, [environment]);

  // Parse Siebel WSDL
  const parseSiebelWsdl = useCallback((xml) => {
    console.log("parseSiebelWsdl called, xml length:", xml?.length);
    try {
      // Pre-process: fix unescaped & in attribute values (common in Siebel WSDLs)
      let fixedXml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, "&amp;");

      const parser = new DOMParser();
      let doc = parser.parseFromString(fixedXml, "text/xml");

      // If XML still broken (common: malformed soap:address with %22 or bad URLs),
      // strip the <service> block (not needed for field extraction) and retry
      if (doc.getElementsByTagName("parsererror").length > 0) {
        console.warn("WSDL has XML errors, stripping <service> block and retrying...");
        fixedXml = fixedXml.replace(/<service[\s\S]*?<\/service>/gi, "");
        doc = parser.parseFromString(fixedXml, "text/xml");
      }
      if (doc.getElementsByTagName("parsererror").length > 0) {
        console.error("WSDL XML parse error:", doc.getElementsByTagName("parsererror")[0].textContent);
        return;
      }

      const XSD_NS = "http://www.w3.org/2001/XMLSchema";
      const WSDL_NS = "http://schemas.xmlsoap.org/wsdl/";

      // Extract definitions name (used as WSDL ref)
      const defs = doc.documentElement;
      const wsdlName = defs.getAttribute("name") || "";

      // Find portType name
      const portType = doc.getElementsByTagNameNS(WSDL_NS, "portType")[0];
      const portName = portType ? portType.getAttribute("name") : "";

      // Find input/output elements from schema (namespace-safe)
      let inputEl = "", outputEl = "";
      const schemaEls = doc.getElementsByTagNameNS(XSD_NS, "element");
      for (const el of schemaEls) {
        const name = el.getAttribute("name") || "";
        if (name.endsWith("_Input") && !inputEl) inputEl = name;
        if (name.endsWith("_Output") && !outputEl) outputEl = name;
      }

      // Fallback: derive from messages
      if (!inputEl || !outputEl) {
        const messages = doc.getElementsByTagNameNS(WSDL_NS, "message");
        for (const msg of messages) {
          const parts = msg.getElementsByTagNameNS(WSDL_NS, "part");
          for (const part of parts) {
            const elAttr = part.getAttribute("element") || "";
            const localName = elAttr.includes(":") ? elAttr.split(":")[1] : elAttr;
            if (localName.endsWith("_Input") && !inputEl) inputEl = localName;
            if (localName.endsWith("_Output") && !outputEl) outputEl = localName;
          }
        }
      }

      // Fallback: derive from portType operation
      if (!inputEl && portType) {
        const ops = portType.getElementsByTagNameNS(WSDL_NS, "operation");
        if (ops.length > 0) {
          const opName = ops[0].getAttribute("name") || "";
          if (!inputEl) inputEl = opName + "_Input";
          if (!outputEl) outputEl = opName + "_Output";
        }
      }

      // WSDL ref: use definitions name if present, otherwise derive from serviceName
      setSiebelWsdlRef(wsdlName || `${serviceName}Siebel`);
      if (inputEl) setSiebelInputElement(inputEl);
      if (outputEl) setSiebelOutputElement(outputEl);
      if (portName) setSiebelPortName(portName);

      // Extract field names from _Input and _Output complexTypes
      const { inputFields, outputFields } = extractSiebelWsdlFields(fixedXml);
      console.log("Siebel WSDL parsed — input fields:", inputFields, "output fields:", outputFields);
      setSiebelInputFields(inputFields);
      setSiebelOutputFields(outputFields);

      // Auto-map request/response fields to actual WSDL field names
      if (inputFields.length > 0) {
        setRequestFields(prev => autoMapSiebelFields(prev, inputFields));
      }
      if (outputFields.length > 0) {
        setResponseFields(prev => autoMapSiebelFields(prev, outputFields));
      }

      setSiebelWsdlParsed(true);
    } catch (e) {
      console.error("parseSiebelWsdl error:", e);
    }
  }, []);

  const namespace = serviceName ? `http://www.iocl.com/epic/${serviceName}/v1.0` : "";
  const [validationErrors, setValidationErrors] = useState([]);

  // Validate all config before generation. Returns array of { level: "error"|"warn", msg }
  const validate = useCallback(() => {
    const errors = [];
    const warn = (msg) => errors.push({ level: "warn", msg });
    const err = (msg) => errors.push({ level: "error", msg });

    if (!projectName.trim()) err("Project Name is required");
    if (!serviceName.trim()) err("Service Name is required");

    // Check for duplicate operation names
    const opNames = operations.map(o => o.operationName || serviceName);
    const dupes = opNames.filter((n, i) => opNames.indexOf(n) !== i);
    if (dupes.length > 0) err(`Duplicate operation name: ${[...new Set(dupes)].join(", ")}`);

    operations.forEach((op, i) => {
      const opLabel = operations.length > 1 ? `Op ${i + 1} (${op.operationName || "unnamed"})` : "Operation";

      if (operations.length > 1 && !op.operationName.trim()) err(`${opLabel}: Operation Name is required`);

      if (op.requestFields.length === 0) err(`${opLabel}: At least one request field is needed`);
      if (op.responseFields.length === 0) err(`${opLabel}: At least one response field is needed`);

      // Check for empty field names
      const emptyReq = op.requestFields.filter(f => !f.name.trim());
      const emptyRes = op.responseFields.filter(f => !f.name.trim());
      if (emptyReq.length > 0) err(`${opLabel}: ${emptyReq.length} request field(s) have no name`);
      if (emptyRes.length > 0) err(`${opLabel}: ${emptyRes.length} response field(s) have no name`);

      if (op.serviceType === "ODS") {
        if (!op.odsServiceId.trim()) err(`${opLabel}: ODS Service ID is required`);
        // Check unmapped fields
        const mappingKey = "odsMapping";
        const unmappedReq = op.requestFields.filter(f => f.name && !f[mappingKey]);
        const unmappedRes = op.responseFields.filter(f => f.name && !f[mappingKey]);
        if (unmappedReq.length > 0) warn(`${opLabel}: ${unmappedReq.length} request field(s) have no ODS mapping — will use app field name`);
        if (unmappedRes.length > 0) warn(`${opLabel}: ${unmappedRes.length} response field(s) have no ODS mapping — will use app field name`);
      }

      if (op.serviceType === "Siebel") {
        if (!op.siebelWsdlParsed) err(`${opLabel}: Siebel WSDL not provided or failed to parse`);
        if (!op.siebelPortName) err(`${opLabel}: Siebel Port Name is missing (paste WSDL to extract)`);
        if (!op.siebelInputElement) warn(`${opLabel}: Siebel Input Element is empty`);
        if (!op.siebelOutputElement) warn(`${opLabel}: Siebel Output Element is empty`);
        if (!op.siebelEndpointUrl.trim()) err(`${opLabel}: Siebel Endpoint URL is required`);
        // Validate Siebel WSDL is well-formed XML
        if (op.siebelWsdlRaw && op.siebelWsdlRaw.trim()) {
          const wsdlCheck = validateXmlString(op.siebelWsdlRaw.trim());
          if (!wsdlCheck.valid) warn(`${opLabel}: Siebel WSDL has XML errors — ${wsdlCheck.error}`);
        }
        // Check unmapped fields
        const unmappedReq = op.requestFields.filter(f => f.name && !f.siebelMapping);
        const unmappedRes = op.responseFields.filter(f => f.name && !f.siebelMapping);
        if (unmappedReq.length > 0) warn(`${opLabel}: ${unmappedReq.length} request field(s) have no Siebel mapping — will use app field name`);
        if (unmappedRes.length > 0) warn(`${opLabel}: ${unmappedRes.length} response field(s) have no Siebel mapping — will use app field name`);
      }

      // Validate ODS sample XML (if provided and looks like XML)
      if (op.serviceType === "ODS") {
        if (op.odsRequestSample && op.odsRequestSample.trim().startsWith("<")) {
          const reqCheck = validateXmlString(op.odsRequestSample.trim());
          if (!reqCheck.valid) warn(`${opLabel}: ODS Request Sample has XML errors — ${reqCheck.error}`);
        }
        if (op.odsResponseSample && op.odsResponseSample.trim().startsWith("<")) {
          const resCheck = validateXmlString(op.odsResponseSample.trim());
          if (!resCheck.valid) warn(`${opLabel}: ODS Response Sample has XML errors — ${resCheck.error}`);
        }
      }
    });

    return errors;
  }, [projectName, serviceName, operations]);

  const handleGenerate = useCallback(() => {
    const errs = validate();
    setValidationErrors(errs);
    if (errs.some(e => e.level === "error")) return;
    if (!projectName || !serviceName) return;

    const effectiveProxyName = proxyName || `${serviceName}PS`;
    const effectiveBindingName = bindingName || `${serviceName}Binding`;
    const effectivePortTypeName = portTypeName || `${serviceName}Port`;
    const effectivePipelineName = `${effectiveProxyName}Pipeline`;

    // Base config shared across all paths
    const baseConfig = {
      projectName, serviceName, proxyName: effectiveProxyName,
      bindingName: effectiveBindingName, portTypeName: effectivePortTypeName, namespace,
      uriPath, authPolicy: "Usr(" + authUsers.join(",") + ")",
      pipelineName: effectivePipelineName,
    };

    const files = [];
    const p = projectName;

    // LocationData files
    files.push({ path: `${p}/_projectdata.LocationData`, content: LOCATION_DATA });
    ["schema", "wsdl", "proxy", "transformation", "Resources", "business"].forEach(folder => {
      files.push({ path: `${p}/${folder}/_folderdata.LocationData`, content: LOCATION_DATA });
    });

    // Always use multi-op path (branch-table pipeline) — even for single op.
    // This ensures the pipeline is extensible when new operations are added later.
    const opConfigs = operations.map(op => ({
      ...baseConfig,
      operationName: op.operationName || serviceName,
      requestElement: op.requestElement || `${op.operationName || serviceName}Request`,
      responseElement: op.responseElement || `${op.operationName || serviceName}Response`,
      requestFields: op.requestFields,
      responseFields: op.responseFields,
      serviceType: op.serviceType,
      odsServiceId: op.odsServiceId,
      odsRequestElement: op.odsRequestElement || op.requestElement || `${op.operationName || serviceName}Request`,
      odsResponseElement: op.odsResponseElement || op.responseElement || `${op.operationName || serviceName}Response`,
      siebelWsdlRef: op.siebelWsdlRef || `${serviceName}Siebel`,
      siebelInputElement: op.siebelInputElement,
      siebelOutputElement: op.siebelOutputElement,
      siebelPortName: op.siebelPortName,
      siebelEndpointUrl: op.siebelEndpointUrl,
      siebelWsdlRaw: op.siebelWsdlRaw,
    }));

    // Shared files: Schema, WSDL, WADL (handles 1 or N operations)
    files.push({ path: `${p}/schema/${serviceName}.XMLSchema`, content: generateMultiOpSchema(baseConfig, opConfigs) });
    files.push({ path: `${p}/wsdl/${serviceName}.WSDL`, content: generateMultiOpWsdl(baseConfig, opConfigs) });
    files.push({ path: `${p}/Resources/${effectiveProxyName}.WADL`, content: generateMultiOpWadl(baseConfig, opConfigs) });

    // ProxyService
    const proxyConfig = { ...baseConfig, operationName: opConfigs[0].operationName, requestElement: opConfigs[0].requestElement, responseElement: opConfigs[0].responseElement };
    files.push({ path: `${p}/proxy/${effectiveProxyName}.ProxyService`, content: generateProxyService(proxyConfig) });

    // Pipeline with branch-table routing (even for single op — extensible structure)
    files.push({ path: `${p}/proxy/${effectivePipelineName}.Pipeline`, content: generateMultiOpPipeline(baseConfig, opConfigs) });

    // Per-operation files: XQuery pairs, BusinessService (Siebel only), Siebel WSDLs
    const siebelWsdlsSeen = new Set();
    opConfigs.forEach(opCfg => {
      const opName = opCfg.operationName;
      if (opCfg.serviceType === 'ODS') {
        files.push({ path: `${p}/transformation/${opName}RequestXQ.Xquery`, content: generateRequestXQ_ODS(opCfg) });
        files.push({ path: `${p}/transformation/${opName}ResponseXQ.Xquery`, content: generateResponseXQ_ODS(opCfg) });
      } else {
        files.push({ path: `${p}/transformation/${opName}RequestXQ.Xquery`, content: generateRequestXQ_Siebel(opCfg) });
        files.push({ path: `${p}/transformation/${opName}ResponseXQ.Xquery`, content: generateResponseXQ_Siebel(opCfg) });
        files.push({ path: `${p}/business/${opName}BS.BusinessService`, content: generateBusinessService({ ...opCfg, serviceName: opName }) });
        // Include Siebel WSDL (deduplicate by ref name)
        if (opCfg.siebelWsdlRaw && !siebelWsdlsSeen.has(opCfg.siebelWsdlRef)) {
          siebelWsdlsSeen.add(opCfg.siebelWsdlRef);
          let cleanWsdl = opCfg.siebelWsdlRaw
            .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, "&amp;")
            .replace(/%22>/g, '">');
          const wrappedWsdl = `<?xml version="1.0" encoding="UTF-8"?>
<con:wsdlEntry xmlns:con="http://www.bea.com/wli/sb/resources/config">
    <con:wsdl><![CDATA[${cleanWsdl}]]></con:wsdl>
    <con:targetNamespace>http://siebel.com/CustomUI</con:targetNamespace>
</con:wsdlEntry>`;
          files.push({ path: `${p}/Resources/${opCfg.siebelWsdlRef}.WSDL`, content: wrappedWsdl });
        }
      }
    });

    // DMZ Layer files — uses first op for pipeline config, all ops for WSDL/WADL/Schema
    if (dmzEnabled) {
      const firstOp = opConfigs[0];
      const dmzFirstOpConfig = {
        ...baseConfig,
        operationName: firstOp.operationName,
        requestElement: firstOp.requestElement,
        responseElement: firstOp.responseElement,
        requestFields: firstOp.requestFields, responseFields: firstOp.responseFields,
      };
      const dvmFallbackSuffix = dmzChannels.mobility ? "Mobility" : dmzChannels.b2b ? "B2B" : dmzChannels.ssf ? "SSF" : "Mobility";
      const envCfg = ENV_CONFIG[environment] || ENV_CONFIG.UAT;
      const dmzConfig = { ...dmzFirstOpConfig, dmzDvmKey: dmzDvmKey || `${serviceName}_${dvmFallbackSuffix}`, dmzAppLayerUrl: dmzAppLayerUrl || `${envCfg.appLayerBaseUrl}/CRMNex${envCfg.uriEnvCode}Ext/${serviceName}`, dmzNxsdName: dmzNxsdName || `nxsd_${serviceName}`, dmzChannels };
      files.push({ path: `${p}/_projectdata.LocationData`, content: LOCATION_DATA, layer: "dmz" });
      ["schema", "wsdl", "proxy", "Resources", "business"].forEach(folder => {
        files.push({ path: `${p}/${folder}/_folderdata.LocationData`, content: LOCATION_DATA, layer: "dmz" });
      });
      files.push({ path: `${p}/schema/${serviceName}.XMLSchema`, content: generateMultiOpSchema(dmzConfig, opConfigs, true), layer: "dmz" });
      files.push({ path: `${p}/schema/${dmzConfig.dmzNxsdName}.XMLSchema`, content: generateNxsdSchema(dmzConfig, opConfigs), layer: "dmz" });
      files.push({ path: `${p}/wsdl/${serviceName}.WSDL`, content: generateDmzPsWsdlFile(baseConfig, opConfigs), layer: "dmz" });
      files.push({ path: `${p}/proxy/${serviceName}PS.ProxyService`, content: generateDmzProxyService(dmzConfig), layer: "dmz" });
      files.push({ path: `${p}/proxy/${serviceName}PSPipeline.Pipeline`, content: generateDmzPipeline(dmzConfig, opConfigs), layer: "dmz" });
      files.push({ path: `${p}/business/${serviceName}BS.BusinessService`, content: generateDmzBusinessService(dmzConfig), layer: "dmz" });
      files.push({ path: `${p}/Resources/${serviceName}BS.WSDL`, content: generateDmzBsWsdl(baseConfig, opConfigs), layer: "dmz" });
      files.push({ path: `${p}/Resources/${serviceName}BS.WADL`, content: generateDmzBsWadl(baseConfig, opConfigs), layer: "dmz" });
      files.push({ path: `${p}/Resources/${serviceName}PS.WADL`, content: generateDmzPsWadl(baseConfig, opConfigs), layer: "dmz" });
    }

    setGeneratedFiles(files);
    setGeneratedEnv(environment);

    // Output XML validation — parse each generated file
    const validation = {};
    files.forEach(f => {
      const fname = f.path.split("/").pop();
      // Skip LocationData (boilerplate) and non-XML files
      if (fname.includes("LocationData")) return;
      const ext = fname.split(".").pop();
      const xmlExts = ["XMLSchema", "WSDL", "WADL", "ProxyService", "Pipeline", "BusinessService", "Xquery"];
      if (!xmlExts.includes(ext)) return;
      validation[f.path] = validateXmlString(f.content);
    });
    setFileValidation(validation);

    setActiveFile(files.find(f => f.path.includes("Pipeline") || f.path.includes("BusinessService"))?.path || files[0].path);
    setStep(4);
  }, [projectName, serviceName, proxyName, operationName, bindingName, portTypeName, namespace, requestElement, responseElement, uriPath, authUsers, requestFields, responseFields, serviceType, odsServiceId, siebelWsdlRef, siebelWsdlRaw, siebelInputElement, siebelOutputElement, siebelPortName, siebelEndpointUrl, dmzEnabled, dmzChannels, dmzDvmKey, dmzAppLayerUrl, dmzNxsdName, operations]);

  const switchEnvironment = useCallback((newEnv) => {
    if (newEnv === generatedEnv || generatedFiles.length === 0) return;
    const oldEnv = generatedEnv;
    const oldCfg = ENV_CONFIG[oldEnv] || ENV_CONFIG.UAT;
    const newCfg = ENV_CONFIG[newEnv] || ENV_CONFIG.UAT;
    const oldSiebelUrl = oldCfg.siebelEndpoint;
    const newSiebelUrl = newCfg.siebelEndpoint;

    const updated = generatedFiles.map(f => {
      let content = f.content;
      // Swap CRMNex{ENV_CODE}Ext in URI paths and URLs
      content = content.replaceAll(`CRMNex${oldCfg.uriEnvCode}Ext`, `CRMNex${newCfg.uriEnvCode}Ext`);
      // Swap Siebel endpoint URLs
      if (oldSiebelUrl && newSiebelUrl) {
        content = content.replaceAll(escXml(oldSiebelUrl), escXml(newSiebelUrl));
        content = content.replaceAll(oldSiebelUrl, newSiebelUrl);
      }
      // Swap App Layer base URLs (DMZ → App)
      content = content.replaceAll(oldCfg.appLayerBaseUrl, newCfg.appLayerBaseUrl);
      return { ...f, content };
    });

    setGeneratedFiles(updated);
    setGeneratedEnv(newEnv);
    setEnvironment(newEnv);

    // Update source state so "New Service" / re-gen stays in sync
    if (serviceName && !manualEdits.uriPath) setUriPath(`/CRMNex${newCfg.uriEnvCode}Ext/${serviceName}`);
    if (!manualEdits.dmzAppLayerUrl) setDmzAppLayerUrl(`${newCfg.appLayerBaseUrl}/CRMNex${newCfg.uriEnvCode}Ext/${serviceName}`);
    if (newSiebelUrl) {
      setOperations(prev => prev.map(o => ({ ...o, siebelEndpointUrl: newSiebelUrl })));
    }

    // Re-validate
    const validation = {};
    updated.forEach(f => {
      const fname = f.path.split("/").pop();
      if (fname.includes("LocationData")) return;
      const ext = fname.split(".").pop();
      const xmlExts = ["XMLSchema", "WSDL", "WADL", "ProxyService", "Pipeline", "BusinessService", "Xquery"];
      if (!xmlExts.includes(ext)) return;
      validation[f.path] = validateXmlString(f.content);
    });
    setFileValidation(validation);
  }, [generatedEnv, generatedFiles, serviceName, manualEdits]);

  const buildZip = async (fileList, exportConfig, filename) => {
    const zip = new JSZip();
    zip.file("ExportInfo", generateExportInfo(fileList, exportConfig));
    const folders = new Set();
    fileList.forEach(f => {
      const parts = f.path.split("/");
      for (let i = 1; i <= parts.length - 1; i++) {
        folders.add(parts.slice(0, i).join("/") + "/");
      }
    });
    folders.forEach(folder => zip.folder(folder));
    fileList.forEach(f => {
      zip.file(f.path, f.content.replace(/\r?\n/g, "\r\n"));
    });
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = async () => {
    const pName = proxyName || `${serviceName}PS`;
    const appFiles = generatedFiles.filter(f => !f.layer);
    const appConfig = {
      projectName, serviceName, proxyName: pName,
      serviceType, siebelWsdlRef,
      pipelineName: `${pName}Pipeline`,
      isDmz: false,
      operations: operations.map(op => ({ operationName: op.operationName || serviceName, serviceType: op.serviceType, siebelWsdlRef: op.siebelWsdlRef })),
    };
    await buildZip(appFiles, appConfig, `${projectName}_App.jar`);

    if (dmzEnabled) {
      const dmzFiles = generatedFiles.filter(f => f.layer === "dmz");
      const dmzExportConfig = {
        projectName, serviceName, proxyName: `${serviceName}PS`,
        serviceType, siebelWsdlRef,
        pipelineName: `${serviceName}PSPipeline`,
        isDmz: true,
        dmzNxsdName: dmzNxsdName || `nxsd_${serviceName}`,
        dmzChannels,
      };
      await buildZip(dmzFiles, dmzExportConfig, `${projectName}_DMZ.jar`);
    }
  };

  const downloadAppOnly = async () => {
    const pName = proxyName || `${serviceName}PS`;
    const appFiles = generatedFiles.filter(f => !f.layer);
    const appConfig = {
      projectName, serviceName, proxyName: pName,
      serviceType, siebelWsdlRef,
      pipelineName: `${pName}Pipeline`,
      isDmz: false,
      operations: operations.map(op => ({ operationName: op.operationName || serviceName, serviceType: op.serviceType, siebelWsdlRef: op.siebelWsdlRef })),
    };
    await buildZip(appFiles, appConfig, `${projectName}_App.jar`);
  };

  const downloadDmzOnly = async () => {
    const dmzFiles = generatedFiles.filter(f => f.layer === "dmz");
    const dmzExportConfig = {
      projectName, serviceName, proxyName: `${serviceName}PS`,
      serviceType, siebelWsdlRef,
      pipelineName: `${serviceName}PSPipeline`,
      isDmz: true,
      dmzNxsdName: dmzNxsdName || `nxsd_${serviceName}`,
      dmzChannels,
    };
    await buildZip(dmzFiles, dmzExportConfig, `${projectName}_DMZ.jar`);
  };

  const downloadFile = (file) => {
    const blob = new Blob([file.content], { type: "text/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.path.split("/").pop();
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a0a", color: "#e5e5e5",
      fontFamily: "'Inter', -apple-system, sans-serif"
    }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(135deg, #141414 0%, #1c1c1c 100%)",
        borderBottom: "1px solid #262626", padding: "20px 24px"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "linear-gradient(135deg, #d4d4d4, #a3a3a3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'JetBrains Mono', monospace", fontWeight: 900, fontSize: 14, color: "#0a0a0a"
          }}>
            OSB
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: -0.5 }}>OSB Service Generator</div>
            <div style={{ fontSize: 12, color: "#737373", fontFamily: "'JetBrains Mono', monospace" }}>IOCL CRMNex | App Layer</div>
          </div>
        </div>
        {/* Step indicators */}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {["Configure", "Fields", "Mappings", "Generated"].map((s, i) => (
            <button key={s} onClick={() => i + 1 <= step && setStep(i + 1)}
              style={{
                background: step === i + 1 ? "#d4d4d4" : step > i + 1 ? "#333333" : "#1c1c1c",
                color: step === i + 1 ? "#0a0a0a" : step > i + 1 ? "#d4d4d4" : "#525252",
                border: "none", borderRadius: 20, padding: "5px 16px", fontSize: 12,
                fontWeight: 700, cursor: i + 1 <= step ? "pointer" : "default",
                fontFamily: "'JetBrains Mono', monospace"
              }}>
              {i + 1}. {s}
            </button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
        {/* Step 1: Configuration */}
        {step === 1 && (
          <div>
            {/* Scenario */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#a3a3a3", marginBottom: 10 }}>Scenario</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {SCENARIOS.map(s => (
                  <button key={s.id} onClick={() => setScenario(s.id)}
                    style={{
                      background: scenario === s.id ? "#292929" : "#1c1c1c",
                      border: scenario === s.id ? "2px solid #d4d4d4" : "1px solid #333333",
                      borderRadius: 10, padding: "12px 16px", textAlign: "left", cursor: "pointer", color: "#e5e5e5"
                    }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>
                      <span style={{ color: "#d4d4d4", fontFamily: "'JetBrains Mono', monospace" }}>{s.id}.</span> {s.label}
                    </div>
                    <div style={{ fontSize: 11, color: "#737373" }}>{s.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Core fields */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 4 }}>Project Name</label>
                <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="e.g. LoyaltyMemberDetailsSBProject"
                  style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 8, padding: "10px 12px", color: "#e5e5e5", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 4 }}>Service Name</label>
                <input value={serviceName} onChange={e => setServiceName(e.target.value)} placeholder="e.g. FetchLoyaltyMemberEnhanced"
                  style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 8, padding: "10px 12px", color: "#e5e5e5", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }} />
              </div>
            </div>

            {/* Environment + Auth */}
            <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 4 }}>Environment</label>
                <select value={environment} onChange={e => setEnvironment(e.target.value)}
                  style={{ width: "100%", background: "#141414", border: "1px solid #333333", borderRadius: 8, padding: "10px 12px", color: "#e5e5e5", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
                  {ENVIRONMENTS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 4 }}>Auth Users</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {authUsers.map((u, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: "#1c1c1c", border: "1px solid #404040", borderRadius: 6, padding: "4px 8px" }}>
                      <input value={u} onChange={e => { const nu = [...authUsers]; nu[i] = e.target.value; setAuthUsers(nu); }}
                        style={{ background: "transparent", border: "none", color: "#e5e5e5", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", width: Math.max(80, u.length * 8), outline: "none" }} />
                      {authUsers.length > 1 && (
                        <button onClick={() => setAuthUsers(authUsers.filter((_, idx) => idx !== i))}
                          style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 14, fontWeight: 700, padding: 0, lineHeight: 1 }}>×</button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => setAuthUsers([...authUsers, ""])}
                    style={{ background: "#d4d4d4", color: "#0a0a0a", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>+</button>
                </div>
                <div style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
                  Generates: Usr({authUsers.join(",")})
                </div>
              </div>
            </div>

            {/* Advanced overrides toggle */}
            <div style={{ marginBottom: 20 }}>
              <button onClick={() => setShowAdvanced(!showAdvanced)}
                style={{ background: "none", border: "none", color: "#525252", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", padding: "4px 0", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▶</span>
                Advanced ({showAdvanced ? "hide" : "override auto-derived names"})
              </button>
              {showAdvanced && (
                <div style={{ marginTop: 8, background: "#ffffff06", borderRadius: 8, padding: 12, border: "1px solid #262626" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                    {[
                      { label: "Proxy Name", key: "proxyName", value: proxyName, set: setProxyName, placeholder: `${serviceName || "Service"}PS` },
                      { label: "Binding Name", key: "bindingName", value: bindingName, set: setBindingName, placeholder: `${serviceName || "Service"}Binding` },
                      { label: "PortType Name", key: "portTypeName", value: portTypeName, set: setPortTypeName, placeholder: `${serviceName || "Service"}Port` },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>{f.label}</label>
                        <input value={f.value} onChange={e => { markManual(f.key); f.set(e.target.value); }} placeholder={f.placeholder}
                          style={{ width: "100%", boxSizing: "border-box", background: "#0a0a0a", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#b3b3b3", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                      </div>
                    ))}
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>URI Path</label>
                    <input value={uriPath} onChange={e => { markManual("uriPath"); setUriPath(e.target.value); }}
                      style={{ width: "100%", boxSizing: "border-box", background: "#0a0a0a", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#b3b3b3", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                  </div>
                </div>
              )}
            </div>

            {/* Operations */}
            <div style={{ background: "#ffffff08", borderRadius: 10, border: "1px solid #333333", padding: 16, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#a3a3a3" }}>Operations ({operations.length})</div>
                <button onClick={addOperation} style={{ background: "#1c1c1c", border: "1px solid #404040", borderRadius: 6, padding: "4px 12px", color: "#d4d4d4", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>+ Add Operation</button>
              </div>
              {/* Operation tabs */}
              <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
                {operations.map((o, i) => (
                  <button key={i} onClick={() => setActiveOpIdx(i)}
                    style={{
                      background: i === activeOpIdx ? "#292929" : "#141414",
                      border: i === activeOpIdx ? "2px solid #d4d4d4" : "1px solid #333333",
                      borderRadius: 6, padding: "6px 12px", cursor: "pointer", color: i === activeOpIdx ? "#e5e5e5" : "#737373",
                      fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                      display: "flex", alignItems: "center", gap: 6
                    }}>
                    {o.operationName || `Op ${i + 1}`}
                    <span style={{ fontSize: 9, color: o.serviceType === "ODS" ? "#6aa36a" : "#a3a36a", background: "#1c1c1c", borderRadius: 3, padding: "1px 4px" }}>{o.serviceType}</span>
                    {operations.length > 1 && (
                      <span onClick={e => { e.stopPropagation(); removeOperation(i); }}
                        style={{ color: "#525252", cursor: "pointer", fontSize: 13, marginLeft: 2 }}>×</span>
                    )}
                  </button>
                ))}
              </div>
              {/* Active operation config */}
              <div style={{ background: "#141414", borderRadius: 8, padding: 14, border: "1px solid #262626" }}>
                {/* Service Type */}
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  {["ODS", "Siebel"].map(t => (
                    <button key={t} onClick={() => setServiceType(t)}
                      style={{
                        flex: 1, background: serviceType === t ? "#292929" : "#1c1c1c",
                        border: serviceType === t ? "2px solid #d4d4d4" : "1px solid #333333",
                        borderRadius: 8, padding: "10px", cursor: "pointer", color: "#e5e5e5", textAlign: "center"
                      }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>{t}</div>
                      <div style={{ fontSize: 10, color: "#a3a3a3", marginTop: 1 }}>
                        {t === "ODS" ? "Common Proxy → PL/SQL" : "Siebel WF → SOAP BS"}
                      </div>
                    </button>
                  ))}
                </div>
                {/* Operation name, request/response elements */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                  {[
                    { label: "Operation Name", key: "operationName", value: operationName, set: setOperationName, placeholder: activeOpIdx === 0 ? "Auto: {ServiceName}" : "e.g. FetchVehicleData" },
                    { label: "Request Element", key: "requestElement", value: requestElement, set: setRequestElement, placeholder: "Auto: {OpName}Request" },
                    { label: "Response Element", key: "responseElement", value: responseElement, set: setResponseElement, placeholder: "Auto: {OpName}Response" },
                  ].map(f => (
                    <div key={f.label}>
                      <label style={{ fontSize: 10, color: "#737373", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>{f.label}</label>
                      <input value={f.value} onChange={e => { markManual(f.key); f.set(e.target.value); }} placeholder={f.placeholder}
                        style={{ width: "100%", boxSizing: "border-box", background: "#0a0a0a", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#e5e5e5", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }} />
                    </div>
                  ))}
                </div>
                {/* ODS config for this operation */}
                {serviceType === "ODS" && (
                  <div style={{ background: "#0a0a0a", borderRadius: 8, padding: 12, border: "1px solid #262626" }}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: "#6aa36a", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>ODS Config</span>
                      <InfoTooltip title="ODS Service Configuration">
                        <div style={{ color: "#737373", marginBottom: 8 }}>ODS routes all requests to a common proxy (<span style={{ color: "#a3a3a3" }}>LocalSiebelQueryToDBPS</span>) which calls a PL/SQL stored procedure. The Service ID tells the backend which procedure to execute.</div>
                        <pre style={{ background: "#0d0d0d", borderRadius: 6, padding: 10, overflow: "auto", fontSize: 9, color: "#6a9a6a", margin: 0, whiteSpace: "pre-wrap", border: "1px solid #333" }}>{`<!-- Pipeline wraps your request as: -->
<sieb:InputParameters>
  <sieb:IP_SERVICE_ID>2026</sieb:IP_SERVICE_ID>
  <sieb:IP_INPUT_XML>
    <cus:YourRequestElement>
      ...transformed fields...
    </cus:YourRequestElement>
  </sieb:IP_INPUT_XML>
</sieb:InputParameters>

<!-- ODS returns: -->
<sieb:OutputParameters>
  <sieb:OP_OUTPUT_XML>
    <cus:YourResponseElement>
      <cus:Error_spcCode>0</cus:Error_spcCode>
      ...response fields...
    </cus:YourResponseElement>
  </sieb:OP_OUTPUT_XML>
  <sieb:OP_ERROR/>
</sieb:OutputParameters>`}</pre>
                        <div style={{ marginTop: 8, color: "#525252", fontSize: 9 }}>
                          <span style={{ color: "#737373" }}>Element names</span> are auto-derived from your app request/response element names
                        </div>
                      </InfoTooltip>
                    </div>
                    <label style={{ fontSize: 10, color: "#737373", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>Service ID (for PL/SQL)</label>
                    <input value={odsServiceId} onChange={e => setOdsServiceId(e.target.value)} placeholder="e.g. 2026"
                      style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#b3b3b3", fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }} />
                    <div style={{ fontSize: 9, color: "#525252", fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
                      ODS element names auto-derived from app request/response elements
                    </div>
                  </div>
                )}
                {/* Siebel config for this operation */}
                {serviceType === "Siebel" && (
                  <div style={{ background: "#0a0a0a", borderRadius: 8, padding: 12, border: "1px solid #262626" }}>
                    <div style={{ fontSize: 11, color: "#a3a36a", fontWeight: 700, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>Siebel Config</div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ display: "flex", alignItems: "center" }}>
                          <label style={{ fontSize: 10, color: "#737373", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>Siebel WSDL</label>
                          <InfoTooltip title="Expected Siebel WSDL Structure">
                            <div style={{ color: "#737373", marginBottom: 8 }}>Paste or upload the WSDL file provided by the Siebel team. The app auto-extracts input/output elements, port name, and endpoint URL.</div>
                            <pre style={{ background: "#0d0d0d", borderRadius: 6, padding: 10, overflow: "auto", fontSize: 9, color: "#6a9a6a", margin: 0, whiteSpace: "pre-wrap", border: "1px solid #333" }}>{`<definitions xmlns="...xmlsoap.org/wsdl/"
  targetNamespace="http://siebel.com/CustomUI">
  <types>
    <xsd:schema targetNamespace="http://siebel.com/CustomUI">

      <!-- INPUT: fields sent TO Siebel -->
      <xsd:element name="EPICWorkflowName_Input">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="Process_spcInstance_spcId"
                       type="xsd:string"/>
          <xsd:element name="INTEGRATION_spcID"
                       type="xsd:string"/>
          <!-- ...more fields... -->
        </xsd:sequence></xsd:complexType>
      </xsd:element>

      <!-- OUTPUT: fields returned BY Siebel -->
      <xsd:element name="EPICWorkflowName_Output">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="Error_spcCode"
                       type="xsd:string"/>
          <xsd:element name="Error_spcMessage"
                       type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>

    </xsd:schema>
  </types>

  <message name="..._Input">
    <part element="tns:..._Input"/>
  </message>
  <portType name="EPICWorkflowName">
    <operation name="EPICWorkflowName">
      <input message="tns:..._Input"/>
      <output message="tns:..._Output"/>
    </operation>
  </portType>

  <service name="EPICWorkflowName">
    <port name="EPICWorkflowName"
          binding="tns:EPICWorkflowName">
      <soap:address location="https://..."/>
    </port>
  </service>
</definitions>`}</pre>
                            <div style={{ marginTop: 8, color: "#525252", fontSize: 9 }}>
                              <span style={{ color: "#737373" }}>Auto-extracted:</span> WSDL Ref, Port Name, Input/Output elements &amp; fields, Endpoint URL
                            </div>
                          </InfoTooltip>
                        </span>
                        <label style={{ fontSize: 10, color: "#a3a36a", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, cursor: "pointer", background: "#1c1c1c", border: "1px solid #333333", borderRadius: 4, padding: "2px 8px" }}>
                          Upload .wsdl
                          <input type="file" accept=".wsdl,.xml,.txt" style={{ display: "none" }} onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                              const text = ev.target.result;
                              setSiebelWsdlRaw(text);
                              setSiebelWsdlParsed(false);
                              if (text.trim()) parseSiebelWsdl(text);
                            };
                            reader.readAsText(file);
                            e.target.value = "";
                          }} />
                        </label>
                      </div>
                      <textarea value={siebelWsdlRaw} onChange={e => {
                        setSiebelWsdlRaw(e.target.value);
                        setSiebelWsdlParsed(false);
                        if (e.target.value.trim()) parseSiebelWsdl(e.target.value);
                      }} placeholder="Paste WSDL XML here or use Upload button above..."
                        style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#e5e5e5", fontSize: 10, fontFamily: "'JetBrains Mono', monospace", minHeight: 80, resize: "vertical" }} />
                    </div>
                    {siebelWsdlParsed && (
                      <div style={{ background: "#141414", borderRadius: 6, padding: 10, marginBottom: 10, border: "1px solid #333333" }}>
                        <div style={{ fontSize: 9, color: "#737373", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Extracted from WSDL</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          {[
                            { label: "WSDL Ref", value: siebelWsdlRef, set: setSiebelWsdlRef },
                            { label: "Port Name", value: siebelPortName, set: setSiebelPortName },
                            { label: "Input Element", value: siebelInputElement, set: setSiebelInputElement },
                            { label: "Output Element", value: siebelOutputElement, set: setSiebelOutputElement },
                          ].map(f => (
                            <div key={f.label}>
                              <label style={{ fontSize: 9, color: "#525252", fontFamily: "'JetBrains Mono', monospace", display: "block", marginBottom: 2 }}>{f.label}</label>
                              <input value={f.value} onChange={e => f.set(e.target.value)}
                                style={{ width: "100%", boxSizing: "border-box", background: "#0a0a0a", border: "1px solid #333333", borderRadius: 4, padding: "5px 7px", color: "#e5e5e5", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }} />
                            </div>
                          ))}
                        </div>
                        {(siebelInputFields.length > 0 || siebelOutputFields.length > 0) && (
                          <div style={{ marginTop: 6, fontSize: 9, color: "#6a9a6a", fontFamily: "'JetBrains Mono', monospace" }}>
                            Found {siebelInputFields.length} input, {siebelOutputFields.length} output fields
                          </div>
                        )}
                      </div>
                    )}
                    <div>
                      <label style={{ fontSize: 10, color: "#737373", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>Siebel Endpoint URL</label>
                      <input value={siebelEndpointUrl} onChange={e => setSiebelEndpointUrl(e.target.value)}
                        style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#e5e5e5", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* DMZ Layer */}
            <div style={{ background: "#ffffff08", borderRadius: 10, border: "1px solid #333333", padding: 16, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: dmzEnabled ? 12 : 0 }}>
                <label style={{ fontSize: 12, color: "#d4d4d4", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={dmzEnabled} onChange={e => setDmzEnabled(e.target.checked)}
                    style={{ accentColor: "#d4d4d4" }} />
                  Generate DMZ Layer
                </label>
                <span style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace" }}>Encryption/Decryption + Token Validation</span>
              </div>
              {dmzEnabled && (
                <div>
                  <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
                    {[{ key: "mobility", label: "Mobility" }, { key: "b2b", label: "B2B" }, { key: "ssf", label: "SSF" }].map(ch => (
                      <label key={ch.key} style={{
                        fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                        color: dmzChannels[ch.key] ? "#d4d4d4" : "#737373",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 5
                      }}>
                        <input type="checkbox" checked={dmzChannels[ch.key]}
                          onChange={e => {
                            const next = { ...dmzChannels, [ch.key]: e.target.checked };
                            // Ensure at least one channel is selected
                            if (!next.mobility && !next.b2b && !next.ssf) return;
                            setDmzChannels(next);
                          }}
                          style={{ accentColor: "#d4d4d4" }} />
                        {ch.label}
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 9, color: "#525252", fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>
                    DVM: {dmzDvmKey || `${serviceName || "Service"}_Mobility`}{dmzChannels.ssf ? ` · SSF DVM: SSFAESKeys.dvm (SSF_\{op\})` : ""} · NXSD: {dmzNxsdName || `nxsd_${serviceName || "Service"}`} · URL: {dmzAppLayerUrl || `${(ENV_CONFIG[environment] || ENV_CONFIG.UAT).appLayerBaseUrl}/CRMNex${(ENV_CONFIG[environment] || ENV_CONFIG.UAT).uriEnvCode}Ext/${serviceName || "Service"}`}
                  </div>
                  <button onClick={() => setShowDmzAdvanced(!showDmzAdvanced)}
                    style={{ background: "none", border: "none", color: "#525252", fontSize: 10, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", padding: "2px 0", display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ display: "inline-block", transform: showDmzAdvanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▶</span>
                    Override DMZ defaults
                  </button>
                  {showDmzAdvanced && (
                    <div style={{ marginTop: 6, background: "#0a0a0a", borderRadius: 6, padding: 10, border: "1px solid #262626" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                        <div>
                          <label style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>DVM Key Name</label>
                          <input value={dmzDvmKey} onChange={e => { markManual("dmzDvmKey"); setDmzDvmKey(e.target.value); }}
                            placeholder={`${serviceName || "Service"}_Mobility`}
                            style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "6px 8px", color: "#b3b3b3", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>NXSD Schema Name</label>
                          <input value={dmzNxsdName} onChange={e => { markManual("dmzNxsdName"); setDmzNxsdName(e.target.value); }}
                            placeholder={`nxsd_${serviceName || "Service"}`}
                            style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "6px 8px", color: "#b3b3b3", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                        </div>
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: "#525252", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, display: "block", marginBottom: 3 }}>App Layer Endpoint URL</label>
                        <input value={dmzAppLayerUrl} onChange={e => { markManual("dmzAppLayerUrl"); setDmzAppLayerUrl(e.target.value); }}
                          placeholder={`http://10.59.17.65/CRMNex${environment}Ext/${serviceName || "Service"}`}
                          style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "6px 8px", color: "#b3b3b3", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Namespace preview */}
            {namespace && (
              <div style={{ background: "#1c1c1c", borderRadius: 8, padding: "10px 14px", marginBottom: 20 }}>
                <span style={{ fontSize: 11, color: "#737373", fontFamily: "'JetBrains Mono', monospace" }}>Namespace: </span>
                <span style={{ fontSize: 12, color: "#d4d4d4", fontFamily: "'JetBrains Mono', monospace" }}>{namespace}</span>
              </div>
            )}

            {/* Step 1 validation warnings */}
            {(() => {
              const issues = [];
              operations.forEach((op, i) => {
                const label = operations.length > 1 ? `Op ${i + 1}` : "";
                if (op.serviceType === "ODS" && !op.odsServiceId.trim()) issues.push(`${label ? label + ": " : ""}ODS Service ID missing`);
                if (op.serviceType === "Siebel" && !op.siebelWsdlParsed) issues.push(`${label ? label + ": " : ""}Siebel WSDL not pasted`);
              });
              if (operations.length > 1) {
                const names = operations.map(o => o.operationName || serviceName);
                const dupes = names.filter((n, i) => names.indexOf(n) !== i);
                if (dupes.length > 0) issues.push(`Duplicate operation name: ${[...new Set(dupes)].join(", ")}`);
              }
              return issues.length > 0 ? (
                <div style={{ marginBottom: 12, background: "#1a1a0a", borderRadius: 8, border: "1px solid #4a4a2a", padding: "8px 12px" }}>
                  {issues.map((msg, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#eab308", fontFamily: "'JetBrains Mono', monospace", marginBottom: i < issues.length - 1 ? 3 : 0 }}>
                      WARN: {msg}
                    </div>
                  ))}
                </div>
              ) : null;
            })()}
            <button onClick={() => setStep(2)} disabled={!projectName || !serviceName}
              style={{
                width: "100%", padding: "14px", background: projectName && serviceName ? "linear-gradient(135deg, #d4d4d4, #a3a3a3)" : "#333333",
                color: projectName && serviceName ? "#0a0a0a" : "#737373", border: "none", borderRadius: 10,
                fontSize: 14, fontWeight: 800, cursor: projectName && serviceName ? "pointer" : "not-allowed",
                fontFamily: "'JetBrains Mono', monospace"
              }}>
              Next → Define Fields
            </button>
          </div>
        )}

        {/* Step 2: Fields */}
        {step === 2 && (
          <div>
            {/* Operation tabs */}
            {operations.length > 1 && (
              <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
                {operations.map((o, i) => (
                  <button key={i} onClick={() => setActiveOpIdx(i)}
                    style={{
                      background: i === activeOpIdx ? "#d4d4d4" : "#1c1c1c",
                      color: i === activeOpIdx ? "#0a0a0a" : "#737373",
                      border: i === activeOpIdx ? "none" : "1px solid #333333",
                      borderRadius: 6, padding: "6px 14px", cursor: "pointer",
                      fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace"
                    }}>
                    {o.operationName || `Op ${i + 1}`}
                    <span style={{ fontSize: 9, marginLeft: 6, opacity: 0.6 }}>{o.serviceType}</span>
                  </button>
                ))}
              </div>
            )}
            {/* JSON Paste Section */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Request JSON", setter: setRequestFields, wsdlFields: siebelInputFields },
                { label: "Response JSON", setter: setResponseFields, wsdlFields: siebelOutputFields },
              ].map(({ label, setter, wsdlFields }) => (
                <div key={label}>
                  <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Paste {label}</label>
                  <textarea placeholder={`{\n  "Field1": "value",\n  "Items": [{"Name": "", "Id": ""}]\n}`}
                    onChange={e => {
                      const parsed = jsonToFields(e.target.value);
                      if (parsed) {
                        // If Siebel WSDL was already parsed, auto-map the new fields immediately
                        if (serviceType === "Siebel" && wsdlFields && wsdlFields.length > 0) {
                          setter(autoMapSiebelFields(parsed, wsdlFields));
                        } else {
                          setter(parsed);
                        }
                      }
                    }}
                    style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #404040", borderRadius: 8, padding: "10px 12px", color: "#e5e5e5", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", minHeight: 100, resize: "vertical" }} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#525252", fontFamily: "'JetBrains Mono', monospace", marginBottom: 16 }}>
              Paste JSON above to auto-populate app fields, or edit manually below
            </div>

            {/* ODS Sample Paste Section */}
            {serviceType === "ODS" && (
              <div style={{ background: "#ffffff08", borderRadius: 10, border: "1px solid #333333", padding: 16, marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: "#d4d4d4", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>ODS Field Mapping</span>
                  <InfoTooltip title="Expected ODS Sample Structure">
                    <div style={{ color: "#737373", marginBottom: 8 }}>Paste a sample ODS request/response in JSON or XML format. The app extracts field names and auto-maps them to your app fields.</div>
                    <div style={{ fontWeight: 700, color: "#a3a3a3", fontSize: 10, marginBottom: 4 }}>JSON format:</div>
                    <pre style={{ background: "#0d0d0d", borderRadius: 6, padding: 10, overflow: "auto", fontSize: 9, color: "#6a9a6a", margin: "0 0 10px", whiteSpace: "pre-wrap", border: "1px solid #333" }}>{`// Request sample
{
  "TrackingId": "",
  "MobileNumber": "",
  "LoyaltyCardNumber": ""
}

// Response sample (with repeating elements)
{
  "Error_spcCode": "0",
  "Error_spcMessage": "",
  "MemberName": "",
  "TransactionList": {
    "Transaction": [
      { "TxnId": "", "Amount": "" }
    ]
  }
}`}</pre>
                    <div style={{ fontWeight: 700, color: "#a3a3a3", fontSize: 10, marginBottom: 4 }}>XML format (from ODS/InputParameters):</div>
                    <pre style={{ background: "#0d0d0d", borderRadius: 6, padding: 10, overflow: "auto", fontSize: 9, color: "#6a9a6a", margin: "0 0 10px", whiteSpace: "pre-wrap", border: "1px solid #333" }}>{`<InputParameters xmlns="...SiebelQueryDBBS">
  <IP_SERVICE_ID>2026</IP_SERVICE_ID>
  <IP_INPUT_XML>
    <FetchLoyaltyInput xmlns="...ods.com/CustomUI">
      <TrackingId/>
      <MobileNumber/>
    </FetchLoyaltyInput>
  </IP_INPUT_XML>
</InputParameters>`}</pre>
                    <div style={{ marginTop: 4, color: "#525252", fontSize: 9 }}>
                      <span style={{ color: "#737373" }}>Auto-extracted:</span> Field names, list structures, Service ID (from XML), element names
                    </div>
                  </InfoTooltip>
                </div>
                <div style={{ fontSize: 11, color: "#737373", fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>
                  Paste ODS request/response sample (JSON or XML) to auto-map ODS field names
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", display: "block", marginBottom: 4 }}>ODS Request Sample</label>
                    <textarea value={odsRequestSample} placeholder={'{\n  "TrackingId": "",\n  "MobileNum": ""\n}'}
                      onChange={e => {
                        setOdsRequestSample(e.target.value);
                        const result = parseOdsSample(e.target.value);
                        const parsed = result?.fields || null;
                        setParsedOdsReqFields(parsed);
                        if (parsed) setRequestFields(prev => autoMapFields(prev, parsed));
                        if (result?.elementName) setOdsRequestElement(result.elementName);
                        if (result?.serviceId) setOdsServiceId(result.serviceId);
                      }}
                      style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #404040", borderRadius: 8, padding: "10px 12px", color: "#e5e5e5", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", minHeight: 80, resize: "vertical" }} />
                    {parsedOdsReqFields && (
                      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {parsedOdsReqFields.map(f => (
                          <span key={f.name} style={{ background: "#1c1c1c", border: "1px solid #404040", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: f.isList ? "#a3a3a3" : f.isGroup ? "#6aa3c9" : "#737373", fontFamily: "'JetBrains Mono', monospace" }}>
                            {f.name}{f.isList ? ` [${f.itemName}]` : f.isGroup ? ` {${f.children?.join(", ")}}` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", display: "block", marginBottom: 4 }}>ODS Response Sample</label>
                    <textarea value={odsResponseSample} placeholder={'{\n  "Error_spcCode": "0",\n  "VehicleList": {\n    "Vehicle": [{"FUEL_TYPE": ""}]\n  }\n}'}
                      onChange={e => {
                        setOdsResponseSample(e.target.value);
                        const result = parseOdsSample(e.target.value);
                        const parsed = result?.fields || null;
                        setParsedOdsResFields(parsed);
                        if (parsed) setResponseFields(prev => autoMapFields(prev, parsed));
                        if (result?.elementName) setOdsResponseElement(result.elementName);
                      }}
                      style={{ width: "100%", boxSizing: "border-box", background: "#141414", border: "1px solid #404040", borderRadius: 8, padding: "10px 12px", color: "#e5e5e5", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", minHeight: 80, resize: "vertical" }} />
                    {parsedOdsResFields && (
                      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {parsedOdsResFields.map(f => (
                          <span key={f.name} style={{ background: "#1c1c1c", border: "1px solid #404040", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: f.isList ? "#a3a3a3" : f.isGroup ? "#6aa3c9" : "#737373", fontFamily: "'JetBrains Mono', monospace" }}>
                            {f.name}{f.isList ? ` [${f.itemName}]` : f.isGroup ? ` {${f.children?.join(", ")}}` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <FieldEditor fields={requestFields} setFields={setRequestFields} label="Request Fields"
              showOdsMapping={serviceType === "ODS"} showSiebelMapping={serviceType === "Siebel"}
              odsSuggestions={serviceType === "ODS" ? parsedOdsReqFields : null} />
            <FieldEditor fields={responseFields} setFields={setResponseFields} label="Response Fields"
              showOdsMapping={serviceType === "ODS"} showSiebelMapping={serviceType === "Siebel"}
              odsSuggestions={serviceType === "ODS" ? parsedOdsResFields : null} />

            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => setStep(1)}
                style={{ flex: 1, padding: "14px", background: "#1c1c1c", color: "#a3a3a3", border: "1px solid #333333", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                ← Back
              </button>
              <button onClick={() => {
                  // Re-run Siebel auto-mapping before entering mapping review
                  if (serviceType === "Siebel" && siebelInputFields.length > 0) {
                    setRequestFields(prev => autoMapSiebelFields(prev, siebelInputFields));
                  }
                  if (serviceType === "Siebel" && siebelOutputFields.length > 0) {
                    setResponseFields(prev => autoMapSiebelFields(prev, siebelOutputFields));
                  }
                  setStep(3);
                }}
                style={{ flex: 2, padding: "14px", background: "linear-gradient(135deg, #d4d4d4, #a3a3a3)", color: "#0a0a0a", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                Next → Review Mappings
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Review Mappings */}
        {step === 3 && (
          <div>
            {/* Operation tabs */}
            {operations.length > 1 && (
              <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
                {operations.map((o, i) => (
                  <button key={i} onClick={() => setActiveOpIdx(i)}
                    style={{
                      background: i === activeOpIdx ? "#d4d4d4" : "#1c1c1c",
                      color: i === activeOpIdx ? "#0a0a0a" : "#737373",
                      border: i === activeOpIdx ? "none" : "1px solid #333333",
                      borderRadius: 6, padding: "6px 14px", cursor: "pointer",
                      fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace"
                    }}>
                    {o.operationName || `Op ${i + 1}`}
                    <span style={{ fontSize: 9, marginLeft: 6, opacity: 0.6 }}>{o.serviceType}</span>
                  </button>
                ))}
              </div>
            )}
            <MappingReview
              requestFields={requestFields}
              responseFields={responseFields}
              setRequestFields={setRequestFields}
              setResponseFields={setResponseFields}
              serviceType={serviceType}
              requestElement={requestElement || `${serviceName}Request`}
              responseElement={responseElement || `${serviceName}Response`}
              siebelInputElement={siebelInputElement}
              siebelOutputElement={siebelOutputElement}
              siebelInputFields={siebelInputFields}
              siebelOutputFields={siebelOutputFields}
            />
            {/* Validation messages */}
            {validationErrors.length > 0 && (
              <div style={{ marginBottom: 12, background: "#1a1a1a", borderRadius: 8, border: "1px solid #333333", padding: 12 }}>
                {validationErrors.map((e, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: i < validationErrors.length - 1 ? 6 : 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: e.level === "error" ? "#ef4444" : "#eab308", flexShrink: 0 }}>
                      {e.level === "error" ? "ERR" : "WARN"}
                    </span>
                    <span style={{ fontSize: 11, color: "#a3a3a3", fontFamily: "'JetBrains Mono', monospace" }}>{e.msg}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => { setValidationErrors([]); setStep(2); }}
                style={{ flex: 1, padding: "14px", background: "#1c1c1c", color: "#a3a3a3", border: "1px solid #333333", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                ← Back to Fields
              </button>
              <button onClick={handleGenerate}
                style={{ flex: 2, padding: "14px", background: "linear-gradient(135deg, #d4d4d4, #a3a3a3)", color: "#0a0a0a", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                Generate OSB Files
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Generated Files */}
        {step === 4 && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {dmzEnabled ? (<>
                <button onClick={downloadAll}
                  style={{ background: "#d4d4d4", color: "#0a0a0a", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                  Download Both JARs
                </button>
                <button onClick={downloadAppOnly}
                  style={{ background: "#1c1c1c", color: "#22d3ee", border: "1px solid #22d3ee", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                  App JAR
                </button>
                <button onClick={downloadDmzOnly}
                  style={{ background: "#1c1c1c", color: "#f59e0b", border: "1px solid #f59e0b", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                  DMZ JAR
                </button>
              </>) : (
                <button onClick={downloadAll}
                  style={{ background: "#d4d4d4", color: "#0a0a0a", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                  Download JAR
                </button>
              )}
              {generatedFiles.find(f => f.path === activeFile) && (
                <button onClick={() => downloadFile(generatedFiles.find(f => f.path === activeFile))}
                  style={{ background: "#1c1c1c", color: "#d4d4d4", border: "1px solid #333333", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                  Download Current
                </button>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                <label style={{ fontSize: 10, color: "#737373", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>ENV</label>
                <select value={generatedEnv} onChange={e => switchEnvironment(e.target.value)}
                  style={{ background: "#141414", border: "1px solid #333333", borderRadius: 6, padding: "8px 10px", color: "#e5e5e5", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer" }}>
                  {ENVIRONMENTS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
              <button onClick={() => { setStep(1); setGeneratedFiles([]); }}
                style={{ background: "#1c1c1c", color: "#a3a3a3", border: "1px solid #333333", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
                ← New Service
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#737373", marginBottom: 12, fontFamily: "'JetBrains Mono', monospace", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span>
                {generatedFiles.length} files generated for {projectName}/{serviceName} ({serviceType})
                {dmzEnabled && ` — App: ${generatedFiles.filter(f => !f.layer).length}, DMZ: ${generatedFiles.filter(f => f.layer === "dmz").length}`}
              </span>
              {Object.keys(fileValidation).length > 0 && (() => {
                const vals = Object.values(fileValidation);
                const passed = vals.filter(v => v.valid).length;
                const failed = vals.filter(v => !v.valid).length;
                return (
                  <span style={{ fontSize: 11, fontWeight: 700, color: failed > 0 ? "#ef4444" : "#6a9a6a" }}>
                    XML: {passed}/{vals.length} valid{failed > 0 ? ` — ${failed} error${failed > 1 ? "s" : ""}` : ""}
                  </span>
                );
              })()}
            </div>
            <FilePreview files={generatedFiles.filter(f => !f.path.includes("LocationData"))} activeFile={activeFile} setActiveFile={setActiveFile} fileValidation={fileValidation} />
          </div>
        )}
      </div>
    </div>
  );
}
