"""SQLite schema.

Actuals are modelled as one row per host with its lifecycle (when it left the EOL OS and
how), which is enough to reconstruct the remaining count on any date. Planned data is
hand-entered and fully audited.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class Portfolio(Base):
    __tablename__ = "portfolio"
    code: Mapped[str] = mapped_column(String, primary_key=True)  # short name used in charts
    full_name: Mapped[str] = mapped_column(String)
    # "mapping" = in the owner-mapping file; "feed" = only seen in the CMDB feed
    origin: Mapped[str] = mapped_column(String, default="mapping")


class Owner(Base):
    __tablename__ = "owner"
    username: Mapped[str] = mapped_column(String, primary_key=True)
    display_name: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="active")  # active | departed | unknown
    first_seen: Mapped[date] = mapped_column(Date)
    note: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class PortfolioMap(Base):
    """Owner -> portfolio fallback, used when the feed carries no portfolio for a host."""

    __tablename__ = "portfolio_map"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner: Mapped[str] = mapped_column(String, unique=True)
    portfolio: Mapped[str] = mapped_column(String, ForeignKey("portfolio.code"))
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())


class Host(Base):
    __tablename__ = "host"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hostname: Mapped[str] = mapped_column(String, unique=True)
    baseline_os: Mapped[str] = mapped_column(String, index=True)  # EOL OS on the baseline date
    current_os: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # None = decommissioned
    status: Mapped[str] = mapped_column(String, index=True)  # remaining | upgraded | decommissioned
    left_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    owner: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    feed_portfolio: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    portfolio: Mapped[str] = mapped_column(String, index=True)  # derived
    host_type: Mapped[str] = mapped_column(String)  # physical | virtual | container | lb
    az: Mapped[str] = mapped_column(String)
    ip: Mapped[str] = mapped_column(String)


class HostCount(Base):
    """Daily count of hosts per EOL OS, as reported by the CMDB (Host Trend + burndown)."""

    __tablename__ = "host_count"
    __table_args__ = (UniqueConstraint("os", "date"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    os: Mapped[str] = mapped_column(String, index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    count: Mapped[int] = mapped_column(Integer)


class PlanLine(Base):
    __tablename__ = "plan_line"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    os: Mapped[str] = mapped_column(String)
    portfolio: Mapped[str] = mapped_column(String)
    application: Mapped[str] = mapped_column(String, default="")
    owner: Mapped[str] = mapped_column(String, default="")
    entry_date: Mapped[date] = mapped_column(Date)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.current_timestamp(), onupdate=func.current_timestamp()
    )
    months: Mapped[list["PlanMonthly"]] = relationship(
        back_populates="line", cascade="all, delete-orphan", order_by="PlanMonthly.month"
    )


class PlanMonthly(Base):
    """Number of hosts to decommission in a given month."""

    __tablename__ = "plan_monthly"
    __table_args__ = (UniqueConstraint("plan_line_id", "month"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_line_id: Mapped[int] = mapped_column(ForeignKey("plan_line.id", ondelete="CASCADE"))
    month: Mapped[str] = mapped_column(String)
    planned_count: Mapped[int] = mapped_column(Integer, default=0)
    line: Mapped[PlanLine] = relationship(back_populates="months")


class PlanAudit(Base):
    """Append-only log of every change to planned data.

    Identity columns are copied onto each row (and plan_line_id is not a foreign key) so
    the history survives deletion of the line it describes.
    """

    __tablename__ = "plan_audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp())
    action: Mapped[str] = mapped_column(String)  # create | update | delete | import
    plan_line_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    os: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    portfolio: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    application: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    owner: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    field: Mapped[str] = mapped_column(String)  # line | os | portfolio | ... | month:YYYY-MM
    old_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    new_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String, default="ui")  # ui | import | seed
    actor: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    detail: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class Meta(Base):
    __tablename__ = "meta"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(Text)
