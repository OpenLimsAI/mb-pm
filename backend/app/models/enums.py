"""所有 enum — 使用 Python str enum，存数据库时是 varchar，便于演化。"""

from enum import StrEnum


class Role(StrEnum):
    ADMIN = "admin"
    CMC_LEAD = "cmc_lead"
    PROJECT_LEAD = "project_lead"
    RD = "rd"
    PRODUCTION = "production"
    QA_QC = "qa_qc"


class ProductType(StrEnum):
    MAB = "单抗"
    MULTI_AB = "多抗"
    OTHER = "其他"


class ProjectStatus(StrEnum):
    ACTIVE = "活跃"
    PAUSED = "暂停"
    COMPLETED = "已完成"
    ARCHIVED = "已归档"


class Health(StrEnum):
    GREEN = "green"
    YELLOW = "yellow"
    RED = "red"


class TaskStatus(StrEnum):
    NOT_STARTED = "未开始"
    IN_PROGRESS = "进行中"
    BLOCKED = "阻塞"
    DELAYED = "延迟"
    DONE = "已完成"
    VERIFIED = "已验证"


class Priority(StrEnum):
    HIGH = "高"
    MEDIUM = "中"
    LOW = "低"


class DependencyType(StrEnum):
    FS = "FS"
    SS = "SS"
    FF = "FF"
    SF = "SF"


class Stage(StrEnum):
    PRECLINICAL = "临床前"
    IND = "IND"
    PH12 = "Ph1/2"
    PH3 = "Ph3"
    BLA = "BLA"
    COMMERCIAL = "商业化"
    POSTMARKET = "上市后"


class Module(StrEnum):
    CELL_LINE = "细胞株"
    USP = "USP"
    DSP = "DSP"
    DP = "DP"
    ANALYTICAL = "分析方法"
    STABILITY = "稳定性"
    PROCESS_VAL = "工艺验证"
    CTD = "CTD"
    OTHER = "其他"


class SpecialtyGroup(StrEnum):
    USP = "上游"
    DSP = "下游"
    DP = "制剂"
    ANALYTICAL = "分析"
    STABILITY = "稳定性"
    PROCESS_VAL = "工艺验证"
    CMC = "CMC综合"


class BatchStage(StrEnum):
    STAGING = "投料准备"
    UPSTREAM = "上游培养"
    DOWNSTREAM = "下游纯化"
    FILL_FINISH = "制剂灌装"
    QC_RELEASE = "QC放行"


class BatchStatus(StrEnum):
    PLANNED = "计划中"
    IN_PRODUCTION = "生产中"
    AWAITING_RELEASE = "待放行"
    RELEASED = "已放行"
    REJECTED = "拒收"
    INVESTIGATION = "调查中"


class EquipmentRunStatus(StrEnum):
    RUNNING = "运行中"
    IDLE = "空闲"
    MAINTENANCE = "维护"
    FAULT = "故障"
    CLEANING = "清洁中"


class DeviationType(StrEnum):
    OOS = "OOS"
    OOT = "OOT"
    PROCESS = "工艺偏差"
    EQUIPMENT = "设备故障"
    ENV_MONITORING = "环境监测偏差"


class DeviationSeverity(StrEnum):
    CRITICAL = "critical"
    MAJOR = "major"
    MINOR = "minor"


class DeviationStatus(StrEnum):
    INVESTIGATING = "调查中"
    CAPA = "CAPA中"
    CLOSED = "已关闭"
