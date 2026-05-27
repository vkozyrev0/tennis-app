--
-- PostgreSQL database dump
--

\restrict fGvUV25h8R2C1E2eYM9pNhfejyqP1dPMwy0IY6d07fLYZSbrkreIm8ozcTgTmy9

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: avoidance_relationship; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.avoidance_relationship AS ENUM (
    'same_club',
    'siblings'
);


--
-- Name: certification_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.certification_type AS ENUM (
    'roving_official',
    'chair_umpire',
    'tournament_referee',
    'deputy_referee',
    'referee_in_training'
);


--
-- Name: distance_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.distance_source AS ENUM (
    'geocoded',
    'manual'
);


--
-- Name: doubles_pairing_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.doubles_pairing_type AS ENUM (
    'mutual',
    'random'
);


--
-- Name: email_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.email_status AS ENUM (
    'new',
    'filed',
    'needs_followup'
);


--
-- Name: entry_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entry_source AS ENUM (
    'usta_roster',
    'late_entry',
    'manual'
);


--
-- Name: room_block_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.room_block_kind AS ENUM (
    'player',
    'official'
);


--
-- Name: selection_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.selection_status AS ENUM (
    'selected',
    'alternate',
    'withdrawn'
);


--
-- Name: tournament_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tournament_type AS ENUM (
    'junior',
    'adult'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'admin',
    'official'
);


--
-- Name: player_track_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.player_track_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        -- only record when a tracked field actually changed
        IF (OLD.usta_number, OLD.first_name, OLD.last_name, OLD.birthdate)
           IS DISTINCT FROM (NEW.usta_number, NEW.first_name, NEW.last_name, NEW.birthdate) THEN
            INSERT INTO player_history
                (player_id, usta_number, first_name, last_name, birthdate,
                 valid_from, valid_to, change_type)
            VALUES (OLD.id, OLD.usta_number, OLD.first_name, OLD.last_name, OLD.birthdate,
                    OLD.updated_at, now(), 'update');
            NEW.updated_at := now();
        END IF;
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        INSERT INTO player_history
            (player_id, usta_number, first_name, last_name, birthdate,
             valid_from, valid_to, change_type)
        VALUES (OLD.id, OLD.usta_number, OLD.first_name, OLD.last_name, OLD.birthdate,
                OLD.updated_at, now(), 'delete');
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    official_id integer NOT NULL,
    site_id integer,
    room_block_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_pay numeric(10,2),
    snapshot_mileage numeric(10,2),
    snapshot_total numeric(10,2),
    rule_version text,
    snapshot_at timestamp with time zone
);


--
-- Name: assignment_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment_day (
    id integer NOT NULL,
    assignment_id integer NOT NULL,
    work_date date NOT NULL,
    working_as public.certification_type NOT NULL,
    rate_applied numeric(8,2) DEFAULT 0 NOT NULL
);


--
-- Name: assignment_day_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.assignment_day ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.assignment_day_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: assignment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.assignment ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.assignment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability (
    id integer NOT NULL,
    official_id integer NOT NULL,
    tournament_id integer NOT NULL,
    available_date date NOT NULL,
    hotel_needed boolean DEFAULT false NOT NULL
);


--
-- Name: availability_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.availability ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.availability_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: certification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certification (
    id integer NOT NULL,
    official_id integer NOT NULL,
    cert_type public.certification_type NOT NULL
);


--
-- Name: certification_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.certification ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.certification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: certification_rate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certification_rate (
    id integer NOT NULL,
    cert_type public.certification_type NOT NULL,
    rate_per_day numeric(8,2) NOT NULL,
    effective_from date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT certification_rate_rate_per_day_check CHECK ((rate_per_day >= (0)::numeric))
);


--
-- Name: certification_rate_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.certification_rate ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.certification_rate_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: division; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.division (
    id integer NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    tournament_type text NOT NULL,
    gender text,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT division_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text])))),
    CONSTRAINT division_tournament_type_check CHECK ((tournament_type = ANY (ARRAY['junior'::text, 'adult'::text])))
);


--
-- Name: division_flexibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.division_flexibility (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    player_id integer NOT NULL,
    home_division text,
    willing_divisions text,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: division_flexibility_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.division_flexibility ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.division_flexibility_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: division_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.division_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: division_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.division_id_seq OWNED BY public.division.id;


--
-- Name: doubles_pair; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doubles_pair (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    age_division text,
    player1_id integer NOT NULL,
    player2_id integer NOT NULL,
    pairing_type public.doubles_pairing_type NOT NULL,
    verified boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doubles_pair_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.doubles_pair ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.doubles_pair_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: doubles_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doubles_request (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    age_division text,
    player_id integer NOT NULL,
    partner_usta text,
    wants_random boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doubles_request_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.doubles_request ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.doubles_request_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: email_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_message (
    id integer NOT NULL,
    tournament_id integer,
    message_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    from_address text,
    subject text,
    body text,
    classification text DEFAULT 'unclassified'::text NOT NULL,
    status public.email_status DEFAULT 'new'::public.email_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_message_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.email_message ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.email_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: hotel; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hotel (
    id integer NOT NULL,
    name text NOT NULL,
    website text,
    street text,
    city text,
    state text,
    zip text,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hotel_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.hotel ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.hotel_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: import_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_batch (
    id integer NOT NULL,
    tournament_id integer,
    import_type text NOT NULL,
    filename text,
    status text DEFAULT 'staged'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: import_batch_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.import_batch ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.import_batch_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: import_row; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_row (
    id integer NOT NULL,
    batch_id integer NOT NULL,
    row_num integer NOT NULL,
    data jsonb NOT NULL,
    valid boolean NOT NULL,
    error text,
    merged boolean DEFAULT false NOT NULL
);


--
-- Name: import_row_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.import_row ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.import_row_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: late_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.late_entry (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    player_id integer NOT NULL,
    request_date date,
    request_time text,
    age_division text,
    events text,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: late_entry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.late_entry ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.late_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: official; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.official (
    id integer NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    street text,
    city text,
    state text,
    zip text,
    phone text,
    email text,
    dietary_restrictions text,
    lat double precision,
    lng double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: official_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.official ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.official_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: official_site_distance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.official_site_distance (
    id integer NOT NULL,
    official_id integer NOT NULL,
    site_id integer NOT NULL,
    one_way_miles numeric(6,1) NOT NULL,
    source public.distance_source DEFAULT 'manual'::public.distance_source NOT NULL,
    CONSTRAINT official_site_distance_one_way_miles_check CHECK ((one_way_miles >= (0)::numeric))
);


--
-- Name: official_site_distance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.official_site_distance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.official_site_distance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pairing_avoidance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pairing_avoidance (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    age_division text,
    relationship public.avoidance_relationship,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pairing_avoidance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pairing_avoidance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pairing_avoidance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pairing_avoidance_member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pairing_avoidance_member (
    id integer NOT NULL,
    pairing_avoidance_id integer NOT NULL,
    player_id integer NOT NULL
);


--
-- Name: pairing_avoidance_member_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pairing_avoidance_member ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pairing_avoidance_member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player (
    id integer NOT NULL,
    usta_number text NOT NULL,
    first_name text,
    last_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    birthdate date,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    city text,
    state text,
    gender text NOT NULL,
    CONSTRAINT player_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text]))))
);


--
-- Name: player_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_history (
    id integer NOT NULL,
    player_id integer NOT NULL,
    usta_number text,
    first_name text,
    last_name text,
    birthdate date,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone DEFAULT now() NOT NULL,
    change_type text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: player_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.player_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.player_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player_hotel_stay; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_hotel_stay (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    player_id integer NOT NULL,
    hotel_name text,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lodging_plan text,
    hotel_id integer
);


--
-- Name: player_hotel_stay_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.player_hotel_stay ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.player_hotel_stay_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: player_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.player ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.player_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: room_block; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_block (
    id integer NOT NULL,
    hotel_id integer NOT NULL,
    tournament_id integer,
    confirmation_number text,
    cancellation_info text,
    check_in date,
    check_out date,
    room_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind public.room_block_kind DEFAULT 'player'::public.room_block_kind NOT NULL,
    CONSTRAINT room_block_dates_ok CHECK (((check_in IS NULL) OR (check_out IS NULL) OR (check_out >= check_in))),
    CONSTRAINT room_block_room_count_check CHECK ((room_count >= 0))
);


--
-- Name: room_block_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.room_block ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.room_block_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: scheduling_avoidance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_avoidance (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    player_id integer NOT NULL,
    avoid_day text,
    avoid_time_range text,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_avoidance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_avoidance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.scheduling_avoidance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    token text NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL
);


--
-- Name: site; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site (
    id integer NOT NULL,
    code text,
    name text NOT NULL,
    street text,
    city text,
    state text,
    zip text,
    lat double precision,
    lng double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: site_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.site ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.site_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tournament (
    id integer NOT NULL,
    name text NOT NULL,
    type public.tournament_type NOT NULL,
    play_start_date date NOT NULL,
    play_end_date date NOT NULL,
    registration_deadline date,
    late_entry_deadline date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_dates_ok CHECK ((play_end_date >= play_start_date))
);


--
-- Name: tournament_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tournament_entry (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    player_id integer NOT NULL,
    age_division text,
    events text,
    selection_status public.selection_status DEFAULT 'selected'::public.selection_status NOT NULL,
    t_shirt_size text,
    dietary_preference text,
    source public.entry_source DEFAULT 'usta_roster'::public.entry_source NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tournament_entry_tshirt_canon CHECK (((t_shirt_size IS NULL) OR (t_shirt_size = ANY (ARRAY['Youth Small'::text, 'Youth Medium'::text, 'Youth Large'::text, 'Adult Small'::text, 'Adult Medium'::text, 'Adult Large'::text, 'Adult Extra Large'::text]))))
);


--
-- Name: tournament_entry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.tournament_entry ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.tournament_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tournament_event (
    id integer NOT NULL,
    name text NOT NULL,
    tournament_type text NOT NULL,
    gender text,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT tournament_event_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text])))),
    CONSTRAINT tournament_event_tournament_type_check CHECK ((tournament_type = ANY (ARRAY['junior'::text, 'adult'::text])))
);


--
-- Name: tournament_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tournament_event_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tournament_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tournament_event_id_seq OWNED BY public.tournament_event.id;


--
-- Name: tournament_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.tournament ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.tournament_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tournament_site; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tournament_site (
    tournament_id integer NOT NULL,
    site_id integer NOT NULL
);


--
-- Name: tshirt_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tshirt_order (
    tournament_id integer NOT NULL,
    ordered_at date,
    snapshot jsonb,
    on_hand jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_account (
    id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role public.user_role DEFAULT 'official'::public.user_role NOT NULL,
    official_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_account_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_account ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.user_account_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: withdrawal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.withdrawal (
    id integer NOT NULL,
    tournament_id integer NOT NULL,
    player_id integer NOT NULL,
    events text,
    reason text,
    notes text,
    was_alternate boolean DEFAULT false NOT NULL,
    source_email_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: withdrawal_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.withdrawal ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.withdrawal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: division id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division ALTER COLUMN id SET DEFAULT nextval('public.division_id_seq'::regclass);


--
-- Name: tournament_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_event ALTER COLUMN id SET DEFAULT nextval('public.tournament_event_id_seq'::regclass);


--
-- Data for Name: assignment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.assignment (id, tournament_id, official_id, site_id, room_block_id, created_at, snapshot_pay, snapshot_mileage, snapshot_total, rule_version, snapshot_at) FROM stdin;
3	3	8	1	\N	2026-05-24 23:38:01.092087-04	1125.00	100.00	1225.00	v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)	2026-05-24 23:42:18.17409-04
4	1	50	\N	\N	2026-05-24 23:53:34.460057-04	0.00	\N	0.00	v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)	2026-05-24 23:53:34.460057-04
7	3	14	\N	\N	2026-05-25 10:41:20.244552-04	1200.00	\N	1200.00	v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)	2026-05-25 10:41:48.766826-04
6	1	52	\N	\N	2026-05-25 00:00:36.718966-04	200.00	\N	200.00	v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)	2026-05-25 00:00:36.890835-04
8	3	3	1	4	2026-05-26 16:39:48.570609-04	600.00	\N	600.00	v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)	2026-05-26 16:40:06.359248-04
9	3	9	1	4	2026-05-26 16:41:28.051656-04	400.00	\N	400.00	v1: pay=sum(per-day cert rate); mileage=clamp((2*oneway-50)*0.65,0,100)	2026-05-26 16:41:34.888914-04
\.


--
-- Data for Name: assignment_day; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.assignment_day (id, assignment_id, work_date, working_as, rate_applied) FROM stdin;
4	3	2026-06-04	tournament_referee	225.00
5	3	2026-06-05	tournament_referee	225.00
6	3	2026-06-06	tournament_referee	225.00
7	3	2026-06-07	tournament_referee	225.00
8	3	2026-06-08	tournament_referee	225.00
11	6	2026-06-01	roving_official	200.00
12	7	2026-06-04	roving_official	200.00
13	7	2026-06-05	chair_umpire	200.00
14	7	2026-06-06	chair_umpire	200.00
15	7	2026-06-07	chair_umpire	200.00
16	7	2026-06-08	chair_umpire	200.00
17	7	2026-06-09	chair_umpire	200.00
18	8	2026-06-05	chair_umpire	200.00
19	8	2026-06-06	chair_umpire	200.00
20	8	2026-06-07	chair_umpire	200.00
21	9	2026-06-06	roving_official	200.00
22	9	2026-06-07	roving_official	200.00
\.


--
-- Data for Name: availability; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.availability (id, official_id, tournament_id, available_date, hotel_needed) FROM stdin;
13	8	3	2026-06-04	t
14	8	3	2026-06-05	t
15	8	3	2026-06-06	t
16	8	3	2026-06-07	t
17	8	3	2026-06-08	t
18	8	3	2026-06-09	t
19	50	1	2026-06-01	f
20	50	1	2026-06-02	f
23	52	1	2026-06-01	f
26	14	3	2026-06-04	f
27	14	3	2026-06-05	f
28	14	3	2026-06-06	f
29	14	3	2026-06-07	f
30	14	3	2026-06-08	f
31	14	3	2026-06-09	f
32	3	3	2026-06-05	t
33	3	3	2026-06-06	t
34	3	3	2026-06-07	t
37	9	3	2026-06-06	t
38	9	3	2026-06-07	t
\.


--
-- Data for Name: certification; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.certification (id, official_id, cert_type) FROM stdin;
1	50	chair_umpire
3	52	roving_official
4	11	roving_official
5	11	chair_umpire
6	14	roving_official
7	14	chair_umpire
8	14	deputy_referee
9	3	roving_official
11	3	chair_umpire
12	33	roving_official
13	9	roving_official
\.


--
-- Data for Name: certification_rate; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.certification_rate (id, cert_type, rate_per_day, effective_from, created_at) FROM stdin;
2	chair_umpire	200.00	2026-05-24	2026-05-24 20:02:49.731825-04
3	tournament_referee	225.00	2026-05-24	2026-05-24 20:02:49.731825-04
1	roving_official	200.00	2026-05-24	2026-05-24 20:02:49.731825-04
7	roving_official	150.00	2026-05-26	2026-05-26 21:59:20.742901-04
8	chair_umpire	200.00	2026-05-26	2026-05-26 21:59:20.742901-04
9	tournament_referee	250.00	2026-05-26	2026-05-26 21:59:20.742901-04
\.


--
-- Data for Name: division; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.division (id, code, label, tournament_type, gender, sort_order) FROM stdin;
1	B10	Boys 10 & Under	junior	male	10
2	G10	Girls 10 & Under	junior	female	20
3	B12	Boys 12 & Under	junior	male	30
4	G12	Girls 12 & Under	junior	female	40
5	B14	Boys 14 & Under	junior	male	50
6	G14	Girls 14 & Under	junior	female	60
7	B16	Boys 16 & Under	junior	male	70
8	G16	Girls 16 & Under	junior	female	80
9	B18	Boys 18 & Under	junior	male	90
10	G18	Girls 18 & Under	junior	female	100
11	NTRP 2.5 Men	NTRP 2.5 Men	adult	male	110
12	NTRP 2.5 Women	NTRP 2.5 Women	adult	female	120
13	NTRP 3.0 Men	NTRP 3.0 Men	adult	male	130
14	NTRP 3.0 Women	NTRP 3.0 Women	adult	female	140
15	NTRP 3.5 Men	NTRP 3.5 Men	adult	male	150
16	NTRP 3.5 Women	NTRP 3.5 Women	adult	female	160
17	NTRP 4.0 Men	NTRP 4.0 Men	adult	male	170
18	NTRP 4.0 Women	NTRP 4.0 Women	adult	female	180
19	NTRP 4.5 Men	NTRP 4.5 Men	adult	male	190
20	NTRP 4.5 Women	NTRP 4.5 Women	adult	female	200
21	NTRP Open Men	NTRP Open Men	adult	male	210
22	NTRP Open Women	NTRP Open Women	adult	female	220
23	Combo 6.0	Combo 6.0 (doubles only)	adult	\N	230
24	Combo 7.0	Combo 7.0 (doubles only)	adult	\N	240
25	Combo 8.0	Combo 8.0 (doubles only)	adult	\N	250
26	Combo 9.0	Combo 9.0 (doubles only)	adult	\N	260
\.


--
-- Data for Name: division_flexibility; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.division_flexibility (id, tournament_id, player_id, home_division, willing_divisions, source_email_id, created_at) FROM stdin;
\.


--
-- Data for Name: doubles_pair; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.doubles_pair (id, tournament_id, age_division, player1_id, player2_id, pairing_type, verified, created_at) FROM stdin;
\.


--
-- Data for Name: doubles_request; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.doubles_request (id, tournament_id, age_division, player_id, partner_usta, wants_random, status, source_email_id, created_at) FROM stdin;
\.


--
-- Data for Name: email_message; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.email_message (id, tournament_id, message_id, received_at, from_address, subject, body, classification, status, created_at) FROM stdin;
1	1	\N	2026-05-25 00:15:03.841364-04	mom@example.com	Late entry for Sam	Can Sam still enter?	late_entry	filed	2026-05-25 00:15:03.841364-04
4	3	\N	2026-05-25 01:48:27.063573-04	\N	Late one	late entry	unclassified	new	2026-05-25 01:48:27.063573-04
3	1	\N	2026-05-25 01:23:34.934771-04	p@x.com	Random doubles partner 95h	please pair my kid randomly	doubles	new	2026-05-25 01:23:34.934771-04
2	1	\N	2026-05-25 00:24:22.924853-04	dad@x.com	Withdraw 68de	pulling out, injury	withdrawal	filed	2026-05-25 00:24:22.924853-04
\.


--
-- Data for Name: hotel; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.hotel (id, name, website, street, city, state, zip, phone, created_at) FROM stdin;
2	TownePlace Suites	\N	\N	Macon	GA	31204	\N	2026-05-24 23:30:52.43457-04
3	Springhill Suites	\N	\N	Macon	GA	31210	\N	2026-05-24 23:31:18.312308-04
6	Courtyard Marriott	\N	\N	Macon	GA	31210	\N	2026-05-25 16:45:33.278479-04
5	Garner	\N	\N	Macon	GA	31220	\N	2026-05-25 16:44:36.730571-04
1	Comfort Inn & Suites Northwest	\N	120 Plantation Inn Dr	Macon	GA	31220	\N	2026-05-24 23:30:39.579932-04
7	Marriott City Center	\N	\N	Macon	GA	31201	\N	2026-05-25 21:28:30.528945-04
\.


--
-- Data for Name: import_batch; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_batch (id, tournament_id, import_type, filename, status, created_at) FROM stdin;
1	1	roster	r.csv	merged	2026-05-25 14:24:35.417053-04
2	1	roster	r.csv	merged	2026-05-25 16:01:35.874865-04
3	1	roster	r.csv	merged	2026-05-25 16:01:36.073796-04
4	1	roster	r.csv	merged	2026-05-25 16:02:09.341049-04
5	1	roster	r.csv	merged	2026-05-25 16:02:09.56002-04
\.


--
-- Data for Name: import_row; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_row (id, batch_id, row_num, data, valid, error, merged) FROM stdin;
1	1	1	{"first_name": "Zoe", "usta_number": "LIVEri3b9", "age_division": "G12", "t_shirt_size": "YM"}	t	\N	t
2	2	1	{"first_name": "Mia", "usta_number": "CONF6n8i7", "age_division": "G12", "t_shirt_size": "YM"}	t	\N	t
3	3	1	{"first_name": "Mia", "usta_number": "CONF6n8i7", "age_division": "G12", "t_shirt_size": "YM"}	t	\N	t
4	4	1	{"first_name": "Mia", "usta_number": "CONFo7ttv", "age_division": "G12", "t_shirt_size": "YM"}	t	\N	t
5	5	1	{"first_name": "Mia", "usta_number": "CONFo7ttv", "age_division": "G12", "t_shirt_size": "YM"}	t	already on the roster — entry overwritten	t
\.


--
-- Data for Name: late_entry; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.late_entry (id, tournament_id, player_id, request_date, request_time, age_division, events, source_email_id, created_at) FROM stdin;
\.


--
-- Data for Name: official; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.official (id, first_name, last_name, street, city, state, zip, phone, email, dietary_restrictions, lat, lng, created_at) FROM stdin;
4	Keith	Burbank	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
5	Bernard	Cameron	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
6	Chee-Ming	Chan	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
7	Ashley	Cooke	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
8	Ashley	Dalton	1444 Burycove Cir	Lawrenceville	GA	30043	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
9	Chaitanya	Deo	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
10	Crystal	Dodds	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
11	Sharon	Doyle	376 River Overlook Rd	Dawsonville	GA	30534	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
12	Nathan	Gehman	1714 N Dixon Dr	Columbus	GA	31906	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
13	Mary	Grace	417 Wexford Cir	Bonaire	GA	31005	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
14	Debbie	Hardy	\N	Milledgeville	GA	31061	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
15	Warren	Harris	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
16	Alana	Hull-Cameron	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
17	Brian	Johnson	4100 Paces Walk SE, Unit 1308	Atlanta	GA	30339	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
18	Gary	Jones	627 Park Dr NE	Atlanta	GA	30306	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
19	Jaheem	Joseph	700 Rankin St NE #1709	Atlanta	GA	30308	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
20	Susan	Kelley	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
21	Maria	Lackey	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
22	Tammy	Lackey	1492 Briaroaks Trl	Atlanta	GA	30329	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
23	Paula	Larkin	4810 Regency Trc	Atlanta	GA	30331	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
24	Louis	Marcotte	2400 Wilderness Way	Marietta	GA	30066	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
25	Craig	Mauldin	4770 Brent Ct SE	Mableton	GA	30126	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
26	Jacqueline	McKellar	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
27	Bruce	McKenzie	15 Wild Fox Ln	Columbus	GA	31820	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
28	Janell	McKenzie	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
29	Sharon	Meadows	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
30	Preston	Morpeth	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
31	Wanda	Morpeth	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
32	Tatia	Neal	2049 Harvest Pond Circle	Suwanee	GA	30024	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
34	Timothy	Pratt	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
35	Josh	Reynolds	347 Serenity Loop	Cataula	GA	31804	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
36	Brad	Sanders	1342 Ga Highway 87 N	Cochran	GA	31014	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
37	David	Settlage	1080 Peachtree St NE	Atlanta	GA	30309	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
38	Morris	Smulevitz	3340 Robinson Farms Ct	Marietta	GA	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
39	Cesar	Soto-Ramos	5745 Ironstone Dr	Columbus	GA	31907	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
40	Leonard	Stewart	1206 Glen Ivy	Marietta	GA	30062	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
41	Shaneji	Ward	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
42	Randy	Willard	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
43	Tracee	Williams	1660 Wilkinson Way	Smyrna	GA	30080	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
44	Joni	Woodard	278 Pine Hill Rd SE	Rydal	GA	30171	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
45	Shawnder	Worthington	230 Cottage Cir	Byron	GA	31008	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
46	Larry	David	502 Junius St	Thomasville	GA	31792	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
47	Robert	Meadows	3000 Ballfields Loop #710	Opelika	AL	36801	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
48	Robert Burke	Walker Jr	376 Milledge Cir	Athens	GA	30606	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
49	Tiffany	Graves-Davis	228 Ismal Dr	Atlanta	GA	30331	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
50	Avail	Zx3vpy	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-24 23:53:34.201731-04
52	Lodge	R2wlw	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-05-25 00:00:36.100035-04
3	Zakiyyah	Amiss	964 Samples Ln	Atlanta	GA	30318	\N	\N	\N	\N	\N	2026-05-24 21:26:02.868584-04
33	Danielle	Pitts	3716 Acorn Dr	Powder Springs	GA	30127	\N	\N	no beef	\N	\N	2026-05-24 21:26:02.868584-04
\.


--
-- Data for Name: official_site_distance; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.official_site_distance (id, official_id, site_id, one_way_miles, source) FROM stdin;
4	8	1	105.0	manual
5	8	3	97.0	manual
6	11	3	87.0	manual
7	12	2	98.0	manual
8	13	3	184.0	manual
9	14	1	38.0	manual
10	14	3	161.0	manual
11	17	3	70.0	manual
12	18	3	80.0	manual
13	19	3	80.0	manual
14	22	3	81.0	manual
15	23	1	85.0	manual
16	23	3	86.0	manual
17	24	1	103.0	manual
18	25	3	76.0	manual
19	27	1	92.0	manual
20	27	3	151.0	manual
21	32	1	108.0	manual
22	33	1	101.0	manual
23	33	3	51.0	manual
24	35	1	92.0	manual
25	35	3	136.0	manual
26	36	1	36.0	manual
27	36	2	40.0	manual
28	37	1	83.0	manual
29	38	3	66.0	manual
30	39	1	94.0	manual
31	40	3	61.0	manual
32	43	1	94.0	manual
33	44	1	152.0	manual
34	44	3	30.0	manual
35	45	3	172.0	manual
36	46	2	155.0	manual
37	47	1	130.0	manual
38	48	1	88.0	manual
39	49	1	83.0	manual
3	3	1	83.0	manual
41	9	1	92.0	manual
\.


--
-- Data for Name: pairing_avoidance; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pairing_avoidance (id, tournament_id, age_division, relationship, source_email_id, created_at) FROM stdin;
1	1	B12	siblings	\N	2026-05-25 00:48:37.20718-04
2	3	\N	same_club	\N	2026-05-26 16:46:04.057126-04
\.


--
-- Data for Name: pairing_avoidance_member; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pairing_avoidance_member (id, pairing_avoidance_id, player_id) FROM stdin;
\.


--
-- Data for Name: player; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.player (id, usta_number, first_name, last_name, created_at, birthdate, updated_at, city, state, gender) FROM stdin;
22	21043871	Ethan	Carter	2026-05-26 21:59:20.742901-04	2010-04-12	2026-05-26 21:59:20.742901-04	Atlanta	GA	male
23	21059234	Liam	Anderson	2026-05-26 21:59:20.742901-04	2008-08-23	2026-05-26 21:59:20.742901-04	Macon	GA	male
24	21071486	Noah	Williams	2026-05-26 21:59:20.742901-04	2007-02-09	2026-05-26 21:59:20.742901-04	Augusta	GA	male
25	21082957	Mason	Thompson	2026-05-26 21:59:20.742901-04	2013-11-30	2026-05-26 21:59:20.742901-04	Savannah	GA	male
26	21094612	Lucas	Martinez	2026-05-26 21:59:20.742901-04	2010-07-18	2026-05-26 21:59:20.742901-04	Athens	GA	male
27	21107385	Oliver	Brown	2026-05-26 21:59:20.742901-04	2008-05-04	2026-05-26 21:59:20.742901-04	Columbus	GA	male
28	21118049	James	Davis	2026-05-26 21:59:20.742901-04	2007-09-27	2026-05-26 21:59:20.742901-04	Marietta	GA	male
29	21126731	Benjamin	Garcia	2026-05-26 21:59:20.742901-04	2013-03-15	2026-05-26 21:59:20.742901-04	Roswell	GA	male
30	21134298	Henry	Wilson	2026-05-26 21:59:20.742901-04	2010-12-08	2026-05-26 21:59:20.742901-04	Alpharetta	GA	male
31	21148563	Alexander	Lee	2026-05-26 21:59:20.742901-04	2008-06-21	2026-05-26 21:59:20.742901-04	Decatur	GA	male
32	21157214	Daniel	Robinson	2026-05-26 21:59:20.742901-04	2007-10-11	2026-05-26 21:59:20.742901-04	Sandy Springs	GA	male
33	21163987	Matthew	Walker	2026-05-26 21:59:20.742901-04	2013-01-25	2026-05-26 21:59:20.742901-04	Johns Creek	GA	male
34	21171258	Jackson	Hall	2026-05-26 21:59:20.742901-04	2010-09-03	2026-05-26 21:59:20.742901-04	Duluth	GA	male
35	21185490	Aiden	Young	2026-05-26 21:59:20.742901-04	2008-04-17	2026-05-26 21:59:20.742901-04	Kennesaw	GA	male
36	21196372	Caleb	Wright	2026-05-26 21:59:20.742901-04	2007-07-29	2026-05-26 21:59:20.742901-04	Smyrna	GA	male
37	21204815	Owen	Patel	2026-05-26 21:59:20.742901-04	2013-10-06	2026-05-26 21:59:20.742901-04	Suwanee	GA	male
38	21215067	Sophia	Chen	2026-05-26 21:59:20.742901-04	2010-03-22	2026-05-26 21:59:20.742901-04	Atlanta	GA	female
39	21223941	Olivia	Mitchell	2026-05-26 21:59:20.742901-04	2008-08-11	2026-05-26 21:59:20.742901-04	Macon	GA	female
40	21238275	Emma	Rodriguez	2026-05-26 21:59:20.742901-04	2007-01-30	2026-05-26 21:59:20.742901-04	Augusta	GA	female
41	21246158	Ava	Johnson	2026-05-26 21:59:20.742901-04	2013-12-04	2026-05-26 21:59:20.742901-04	Savannah	GA	female
42	21257423	Isabella	Kim	2026-05-26 21:59:20.742901-04	2010-06-19	2026-05-26 21:59:20.742901-04	Athens	GA	female
43	21268106	Mia	Nguyen	2026-05-26 21:59:20.742901-04	2008-04-08	2026-05-26 21:59:20.742901-04	Columbus	GA	female
44	21274891	Charlotte	Adams	2026-05-26 21:59:20.742901-04	2007-11-15	2026-05-26 21:59:20.742901-04	Marietta	GA	female
45	21283659	Amelia	Clark	2026-05-26 21:59:20.742901-04	2013-05-26	2026-05-26 21:59:20.742901-04	Roswell	GA	female
46	21295174	Harper	Lewis	2026-05-26 21:59:20.742901-04	2010-10-02	2026-05-26 21:59:20.742901-04	Alpharetta	GA	female
47	21307842	Evelyn	Scott	2026-05-26 21:59:20.742901-04	2008-07-13	2026-05-26 21:59:20.742901-04	Decatur	GA	female
48	21318296	Abigail	Turner	2026-05-26 21:59:20.742901-04	2007-03-24	2026-05-26 21:59:20.742901-04	Sandy Springs	GA	female
49	21326710	Ella	Phillips	2026-05-26 21:59:20.742901-04	2013-09-09	2026-05-26 21:59:20.742901-04	Johns Creek	GA	female
50	21334987	Lily	Campbell	2026-05-26 21:59:20.742901-04	2010-02-28	2026-05-26 21:59:20.742901-04	Duluth	GA	female
51	21349153	Grace	Sullivan	2026-05-26 21:59:20.742901-04	2008-11-05	2026-05-26 21:59:20.742901-04	Kennesaw	GA	female
52	21356428	Chloe	Rivera	2026-05-26 21:59:20.742901-04	2007-05-17	2026-05-26 21:59:20.742901-04	Smyrna	GA	female
53	21368790	Zoey	Foster	2026-05-26 21:59:20.742901-04	2013-08-21	2026-05-26 21:59:20.742901-04	Suwanee	GA	female
\.


--
-- Data for Name: player_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.player_history (id, player_id, usta_number, first_name, last_name, birthdate, valid_from, valid_to, change_type, changed_at) FROM stdin;
1	14	UX2335	\N	Chip	\N	2026-05-25 01:34:22.714502-04	2026-05-25 17:33:05.345423-04	update	2026-05-25 17:33:05.345423-04
2	14	UX2335	\N	Chip_tmp	\N	2026-05-25 17:33:05.345423-04	2026-05-25 17:33:05.446638-04	update	2026-05-25 17:33:05.446638-04
3	10	DA55g	\N	DA55g	\N	2026-05-25 01:06:35.651431-04	2026-05-26 16:38:19.222033-04	update	2026-05-26 16:38:19.222033-04
4	20	HFzid80	\N	\N	\N	2026-05-25 16:45:33.365059-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
5	11	DB55g	\N	DB55g	\N	2026-05-25 01:06:35.745662-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
6	12	DC55g	\N	DC55g	\N	2026-05-25 01:06:35.831406-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
7	13	DD55g	\N	DD55g	\N	2026-05-25 01:06:35.918862-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
8	21	SC6j58i	Q	Zephyr	\N	2026-05-25 17:05:01.569926-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
9	5	PHp6c2	Pat	Guest	\N	2026-05-25 00:37:14.656292-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
10	19	HF3e359	\N	\N	\N	2026-05-25 16:45:33.205067-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
11	8	PAow41	\N	Fam1	\N	2026-05-25 00:48:37.20718-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
12	3	SCH3anf	Sue	Time	\N	2026-05-25 00:29:48.870169-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
13	9	PAow42	\N	Fam2	\N	2026-05-25 00:48:37.20718-04	2026-05-26 22:04:07.904022-04	delete	2026-05-26 22:04:07.904022-04
14	15	LPykbkv	\N	\N	\N	2026-05-25 11:51:05.378184-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
15	17	CONF6n8i7	Mia	\N	\N	2026-05-25 16:01:35.964921-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
16	4	DF3anf	Dan	Flex	\N	2026-05-25 00:29:49.333663-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
17	6	TSp6c2	Tee	Shirt	\N	2026-05-25 00:37:14.989729-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
18	14	UX2335	\N	Chip	\N	2026-05-25 17:33:05.446638-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
19	2	WD68de	Wendy	Draw	\N	2026-05-25 00:24:22.740175-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
20	16	LIVEri3b9	Zoe	\N	\N	2026-05-25 14:24:35.537545-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
21	7	PAow40	\N	Fam0	\N	2026-05-25 00:48:37.20718-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
22	1	WEBLATEy3du	Sam	Jones	\N	2026-05-25 00:15:05.836754-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
23	18	CONFo7ttv	Mia	\N	\N	2026-05-25 16:02:09.449053-04	2026-05-26 22:04:45.000563-04	delete	2026-05-26 22:04:45.000563-04
24	10	9999999999	Sammie	Adams	\N	2026-05-26 16:38:19.222033-04	2026-05-26 22:08:59.526102-04	delete	2026-05-26 22:08:59.526102-04
\.


--
-- Data for Name: player_hotel_stay; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.player_hotel_stay (id, tournament_id, player_id, hotel_name, source_email_id, created_at, lodging_plan, hotel_id) FROM stdin;
\.


--
-- Data for Name: room_block; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.room_block (id, hotel_id, tournament_id, confirmation_number, cancellation_info, check_in, check_out, room_count, created_at, kind) FROM stdin;
4	1	3	\N	\N	2026-06-03	2026-06-09	4	2026-05-25 10:42:58.59976-04	official
5	2	3	\N	48 hrs before arrival	2026-06-03	2026-06-10	1	2026-05-25 10:43:24.694386-04	official
\.


--
-- Data for Name: scheduling_avoidance; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.scheduling_avoidance (id, tournament_id, player_id, avoid_day, avoid_time_range, source_email_id, created_at) FROM stdin;
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (version, applied_at) FROM stdin;
0001_core_schema.sql	2026-05-24 02:53:23.171027-04
0002_rates_hotels.sql	2026-05-24 03:21:30.063026-04
0003_mappings_assignments.sql	2026-05-24 03:28:58.715451-04
0004_player_history.sql	2026-05-24 04:02:46.676538-04
0005_assignment_snapshots.sql	2026-05-24 21:22:14.599337-04
0006_certifications.sql	2026-05-24 22:26:09.885569-04
0007_availability.sql	2026-05-24 22:26:09.927276-04
0008_auth.sql	2026-05-24 23:14:52.164796-04
0009_certification_types.sql	2026-05-24 23:48:22.089393-04
0010_room_block_kind.sql	2026-05-24 23:57:27.401952-04
0011_player_ops.sql	2026-05-25 00:11:32.500687-04
0012_withdrawals.sql	2026-05-25 00:21:08.17339-04
0013_avoid_divflex.sql	2026-05-25 00:27:14.754197-04
0014_player_hotels.sql	2026-05-25 00:33:40.172089-04
0015_pairing_avoidances.sql	2026-05-25 00:45:23.84629-04
0016_doubles.sql	2026-05-25 01:03:09.525021-04
0017_session_expiry.sql	2026-05-25 03:15:17.097813-04
0018_lodging_plan.sql	2026-05-25 11:50:24.448815-04
0019_player_city_state.sql	2026-05-25 13:35:29.734622-04
0020_import_staging.sql	2026-05-25 14:22:33.116469-04
0021_perf_indexes.sql	2026-05-25 16:04:47.83764-04
0022_tshirt_constraint.sql	2026-05-25 16:07:10.302362-04
0023_player_hotel_fk.sql	2026-05-25 16:44:36.730571-04
0024_tshirt_orders.sql	2026-05-26 20:12:01.329144-04
0025_player_gender.sql	2026-05-26 20:30:19.550497-04
0026_player_gender_required.sql	2026-05-26 21:22:04.857791-04
0027_divisions_events.sql	2026-05-26 21:32:29.841753-04
\.


--
-- Data for Name: session; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.session (token, user_id, created_at, expires_at) FROM stdin;
4JKwZin7qPEKw0XyvXiXVCdDBZ6WIFA3ljeENlNK_Co	1	2026-05-27 10:18:58.546048-04	2026-06-26 10:18:58.546048-04
\.


--
-- Data for Name: site; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.site (id, code, name, street, city, state, zip, lat, lng, created_at) FROM stdin;
2	RSTC	Rome Tennis Center at Berry College	\N	Rome	GA	\N	\N	\N	2026-05-24 20:02:49.731825-04
3	ROME	Rome Tennis Center	\N	Rome	GA	\N	\N	\N	2026-05-24 20:02:49.731825-04
1	JDS	John Drew Smith Tennis Center	\N	Macon	GA	\N	\N	\N	2026-05-24 20:02:49.731825-04
\.


--
-- Data for Name: tournament; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tournament (id, name, type, play_start_date, play_end_date, registration_deadline, late_entry_deadline, created_at) FROM stdin;
1	Spring Junior Open 2026	junior	2026-06-01	2026-06-04	2026-05-20	2026-05-28	2026-05-24 20:02:49.731825-04
3	Southern 14's Summer Champs	junior	2026-06-04	2026-06-09	2026-05-24	2026-06-01	2026-05-24 23:28:22.291225-04
8	test2	junior	2026-05-27	2026-05-28	2026-05-27	2026-05-27	2026-05-27 02:54:50.801352-04
\.


--
-- Data for Name: tournament_entry; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tournament_entry (id, tournament_id, player_id, age_division, events, selection_status, t_shirt_size, dietary_preference, source, created_at) FROM stdin;
20	3	23	B10	Singles	selected	Youth Small	-	usta_roster	2026-05-26 22:15:50.822389-04
\.


--
-- Data for Name: tournament_event; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tournament_event (id, name, tournament_type, gender, sort_order) FROM stdin;
1	Singles	junior	\N	10
2	Doubles	junior	\N	20
3	Men's Singles	adult	male	30
4	Women's Singles	adult	female	40
5	Men's Doubles	adult	male	50
6	Women's Doubles	adult	female	60
7	Mixed Doubles	adult	\N	70
\.


--
-- Data for Name: tournament_site; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tournament_site (tournament_id, site_id) FROM stdin;
3	1
1	1
1	2
\.


--
-- Data for Name: tshirt_order; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tshirt_order (tournament_id, ordered_at, snapshot, on_hand, updated_at) FROM stdin;
1	\N	\N	{"AL": 0, "AM": 0, "AS": 0, "YL": 0, "YM": 0, "YS": 0, "AXL": 0}	2026-05-26 20:21:11.91741-04
3	\N	\N	{}	2026-05-26 21:56:25.418697-04
\.


--
-- Data for Name: user_account; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_account (id, username, password_hash, role, official_id, created_at) FROM stdin;
1	admin	pbkdf2_sha256$200000$18cc76964f7fe7ba52802209f6f4c764$02dc5896b0b62a6459a1d26e82f18f28ed133666e9f651f9959b8d48e6144119	admin	\N	2026-05-24 23:20:41.11458-04
\.


--
-- Data for Name: withdrawal; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.withdrawal (id, tournament_id, player_id, events, reason, notes, was_alternate, source_email_id, created_at) FROM stdin;
\.


--
-- Name: assignment_day_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.assignment_day_id_seq', 22, true);


--
-- Name: assignment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.assignment_id_seq', 9, true);


--
-- Name: availability_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.availability_id_seq', 38, true);


--
-- Name: certification_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.certification_id_seq', 13, true);


--
-- Name: certification_rate_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.certification_rate_id_seq', 18, true);


--
-- Name: division_flexibility_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.division_flexibility_id_seq', 2, true);


--
-- Name: division_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.division_id_seq', 26, true);


--
-- Name: doubles_pair_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.doubles_pair_id_seq', 3, true);


--
-- Name: doubles_request_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.doubles_request_id_seq', 6, true);


--
-- Name: email_message_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.email_message_id_seq', 7, true);


--
-- Name: hotel_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.hotel_id_seq', 8, true);


--
-- Name: import_batch_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.import_batch_id_seq', 6, true);


--
-- Name: import_row_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.import_row_id_seq', 5, true);


--
-- Name: late_entry_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.late_entry_id_seq', 6, true);


--
-- Name: official_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.official_id_seq', 53, true);


--
-- Name: official_site_distance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.official_site_distance_id_seq', 41, true);


--
-- Name: pairing_avoidance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pairing_avoidance_id_seq', 2, true);


--
-- Name: pairing_avoidance_member_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pairing_avoidance_member_id_seq', 6, true);


--
-- Name: player_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.player_history_id_seq', 24, true);


--
-- Name: player_hotel_stay_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.player_hotel_stay_id_seq', 5, true);


--
-- Name: player_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.player_id_seq', 149, true);


--
-- Name: room_block_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.room_block_id_seq', 6, true);


--
-- Name: scheduling_avoidance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.scheduling_avoidance_id_seq', 4, true);


--
-- Name: site_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.site_id_seq', 20, true);


--
-- Name: tournament_entry_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tournament_entry_id_seq', 20, true);


--
-- Name: tournament_event_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tournament_event_id_seq', 7, true);


--
-- Name: tournament_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.tournament_id_seq', 9, true);


--
-- Name: user_account_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.user_account_id_seq', 5, true);


--
-- Name: withdrawal_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.withdrawal_id_seq', 4, true);


--
-- Name: assignment_day assignment_day_assignment_id_work_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_day
    ADD CONSTRAINT assignment_day_assignment_id_work_date_key UNIQUE (assignment_id, work_date);


--
-- Name: assignment_day assignment_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_day
    ADD CONSTRAINT assignment_day_pkey PRIMARY KEY (id);


--
-- Name: assignment assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_pkey PRIMARY KEY (id);


--
-- Name: assignment assignment_tournament_id_official_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_tournament_id_official_id_key UNIQUE (tournament_id, official_id);


--
-- Name: availability availability_official_id_tournament_id_available_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_official_id_tournament_id_available_date_key UNIQUE (official_id, tournament_id, available_date);


--
-- Name: availability availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_pkey PRIMARY KEY (id);


--
-- Name: certification certification_official_id_cert_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certification
    ADD CONSTRAINT certification_official_id_cert_type_key UNIQUE (official_id, cert_type);


--
-- Name: certification certification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certification
    ADD CONSTRAINT certification_pkey PRIMARY KEY (id);


--
-- Name: certification_rate certification_rate_cert_type_effective_from_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certification_rate
    ADD CONSTRAINT certification_rate_cert_type_effective_from_key UNIQUE (cert_type, effective_from);


--
-- Name: certification_rate certification_rate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certification_rate
    ADD CONSTRAINT certification_rate_pkey PRIMARY KEY (id);


--
-- Name: division division_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division
    ADD CONSTRAINT division_code_key UNIQUE (code);


--
-- Name: division_flexibility division_flexibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division_flexibility
    ADD CONSTRAINT division_flexibility_pkey PRIMARY KEY (id);


--
-- Name: division division_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division
    ADD CONSTRAINT division_pkey PRIMARY KEY (id);


--
-- Name: doubles_pair doubles_pair_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_pair
    ADD CONSTRAINT doubles_pair_pkey PRIMARY KEY (id);


--
-- Name: doubles_request doubles_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_request
    ADD CONSTRAINT doubles_request_pkey PRIMARY KEY (id);


--
-- Name: email_message email_message_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_message_id_key UNIQUE (message_id);


--
-- Name: email_message email_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_pkey PRIMARY KEY (id);


--
-- Name: hotel hotel_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hotel
    ADD CONSTRAINT hotel_pkey PRIMARY KEY (id);


--
-- Name: import_batch import_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batch
    ADD CONSTRAINT import_batch_pkey PRIMARY KEY (id);


--
-- Name: import_row import_row_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_row
    ADD CONSTRAINT import_row_pkey PRIMARY KEY (id);


--
-- Name: late_entry late_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.late_entry
    ADD CONSTRAINT late_entry_pkey PRIMARY KEY (id);


--
-- Name: official official_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official
    ADD CONSTRAINT official_pkey PRIMARY KEY (id);


--
-- Name: official_site_distance official_site_distance_official_id_site_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_site_distance
    ADD CONSTRAINT official_site_distance_official_id_site_id_key UNIQUE (official_id, site_id);


--
-- Name: official_site_distance official_site_distance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_site_distance
    ADD CONSTRAINT official_site_distance_pkey PRIMARY KEY (id);


--
-- Name: pairing_avoidance_member pairing_avoidance_member_pairing_avoidance_id_player_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance_member
    ADD CONSTRAINT pairing_avoidance_member_pairing_avoidance_id_player_id_key UNIQUE (pairing_avoidance_id, player_id);


--
-- Name: pairing_avoidance_member pairing_avoidance_member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance_member
    ADD CONSTRAINT pairing_avoidance_member_pkey PRIMARY KEY (id);


--
-- Name: pairing_avoidance pairing_avoidance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance
    ADD CONSTRAINT pairing_avoidance_pkey PRIMARY KEY (id);


--
-- Name: player_history player_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_history
    ADD CONSTRAINT player_history_pkey PRIMARY KEY (id);


--
-- Name: player_hotel_stay player_hotel_stay_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_hotel_stay
    ADD CONSTRAINT player_hotel_stay_pkey PRIMARY KEY (id);


--
-- Name: player player_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player
    ADD CONSTRAINT player_pkey PRIMARY KEY (id);


--
-- Name: player player_usta_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player
    ADD CONSTRAINT player_usta_number_key UNIQUE (usta_number);


--
-- Name: room_block room_block_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_block
    ADD CONSTRAINT room_block_pkey PRIMARY KEY (id);


--
-- Name: scheduling_avoidance scheduling_avoidance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_avoidance
    ADD CONSTRAINT scheduling_avoidance_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (token);


--
-- Name: site site_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site
    ADD CONSTRAINT site_code_key UNIQUE (code);


--
-- Name: site site_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site
    ADD CONSTRAINT site_pkey PRIMARY KEY (id);


--
-- Name: tournament_entry tournament_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_entry
    ADD CONSTRAINT tournament_entry_pkey PRIMARY KEY (id);


--
-- Name: tournament_entry tournament_entry_tournament_id_player_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_entry
    ADD CONSTRAINT tournament_entry_tournament_id_player_id_key UNIQUE (tournament_id, player_id);


--
-- Name: tournament_event tournament_event_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_event
    ADD CONSTRAINT tournament_event_name_key UNIQUE (name);


--
-- Name: tournament_event tournament_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_event
    ADD CONSTRAINT tournament_event_pkey PRIMARY KEY (id);


--
-- Name: tournament tournament_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament
    ADD CONSTRAINT tournament_name_key UNIQUE (name);


--
-- Name: tournament tournament_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament
    ADD CONSTRAINT tournament_pkey PRIMARY KEY (id);


--
-- Name: tournament_site tournament_site_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_site
    ADD CONSTRAINT tournament_site_pkey PRIMARY KEY (tournament_id, site_id);


--
-- Name: tshirt_order tshirt_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tshirt_order
    ADD CONSTRAINT tshirt_order_pkey PRIMARY KEY (tournament_id);


--
-- Name: user_account user_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_account
    ADD CONSTRAINT user_account_pkey PRIMARY KEY (id);


--
-- Name: user_account user_account_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_account
    ADD CONSTRAINT user_account_username_key UNIQUE (username);


--
-- Name: withdrawal withdrawal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.withdrawal
    ADD CONSTRAINT withdrawal_pkey PRIMARY KEY (id);


--
-- Name: idx_assignment_day_asg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignment_day_asg ON public.assignment_day USING btree (assignment_id);


--
-- Name: idx_assignment_official; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignment_official ON public.assignment USING btree (official_id);


--
-- Name: idx_assignment_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignment_tournament ON public.assignment USING btree (tournament_id);


--
-- Name: idx_availability_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_availability_tournament ON public.availability USING btree (tournament_id);


--
-- Name: idx_certification_official; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certification_official ON public.certification USING btree (official_id);


--
-- Name: idx_distance_official_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distance_official_site ON public.official_site_distance USING btree (official_id, site_id);


--
-- Name: idx_div_flex_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_div_flex_tournament ON public.division_flexibility USING btree (tournament_id);


--
-- Name: idx_doubles_pair_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doubles_pair_tournament ON public.doubles_pair USING btree (tournament_id);


--
-- Name: idx_doubles_req_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doubles_req_tournament ON public.doubles_request USING btree (tournament_id);


--
-- Name: idx_doubles_request_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doubles_request_tournament ON public.doubles_request USING btree (tournament_id);


--
-- Name: idx_email_message_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_message_tournament ON public.email_message USING btree (tournament_id);


--
-- Name: idx_email_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_tournament ON public.email_message USING btree (tournament_id);


--
-- Name: idx_entry_player; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entry_player ON public.tournament_entry USING btree (player_id);


--
-- Name: idx_entry_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entry_tournament ON public.tournament_entry USING btree (tournament_id);


--
-- Name: idx_import_row_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_row_batch ON public.import_row USING btree (batch_id);


--
-- Name: idx_late_entry_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_late_entry_tournament ON public.late_entry USING btree (tournament_id);


--
-- Name: idx_pairing_avoid_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pairing_avoid_tournament ON public.pairing_avoidance USING btree (tournament_id);


--
-- Name: idx_player_history_player; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_history_player ON public.player_history USING btree (player_id);


--
-- Name: idx_player_hotel_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_hotel_hotel ON public.player_hotel_stay USING btree (hotel_id);


--
-- Name: idx_player_hotel_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_hotel_tournament ON public.player_hotel_stay USING btree (tournament_id);


--
-- Name: idx_player_hotel_tournament_player; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_hotel_tournament_player ON public.player_hotel_stay USING btree (tournament_id, player_id);


--
-- Name: idx_room_block_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_room_block_hotel ON public.room_block USING btree (hotel_id);


--
-- Name: idx_room_block_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_room_block_kind ON public.room_block USING btree (tournament_id, kind);


--
-- Name: idx_room_block_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_room_block_tournament ON public.room_block USING btree (tournament_id);


--
-- Name: idx_sched_avoid_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_avoid_tournament ON public.scheduling_avoidance USING btree (tournament_id);


--
-- Name: idx_session_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_expires ON public.session USING btree (expires_at);


--
-- Name: idx_session_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_user ON public.session USING btree (user_id);


--
-- Name: idx_withdrawal_tournament; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_withdrawal_tournament ON public.withdrawal USING btree (tournament_id);


--
-- Name: player trg_player_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_player_history BEFORE DELETE OR UPDATE ON public.player FOR EACH ROW EXECUTE FUNCTION public.player_track_history();


--
-- Name: assignment_day assignment_day_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_day
    ADD CONSTRAINT assignment_day_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.assignment(id) ON DELETE CASCADE;


--
-- Name: assignment assignment_official_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_official_id_fkey FOREIGN KEY (official_id) REFERENCES public.official(id) ON DELETE CASCADE;


--
-- Name: assignment assignment_room_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_room_block_id_fkey FOREIGN KEY (room_block_id) REFERENCES public.room_block(id) ON DELETE SET NULL;


--
-- Name: assignment assignment_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id) ON DELETE SET NULL;


--
-- Name: assignment assignment_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: availability availability_official_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_official_id_fkey FOREIGN KEY (official_id) REFERENCES public.official(id) ON DELETE CASCADE;


--
-- Name: availability availability_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability
    ADD CONSTRAINT availability_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: certification certification_official_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certification
    ADD CONSTRAINT certification_official_id_fkey FOREIGN KEY (official_id) REFERENCES public.official(id) ON DELETE CASCADE;


--
-- Name: division_flexibility division_flexibility_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division_flexibility
    ADD CONSTRAINT division_flexibility_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: division_flexibility division_flexibility_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division_flexibility
    ADD CONSTRAINT division_flexibility_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: division_flexibility division_flexibility_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.division_flexibility
    ADD CONSTRAINT division_flexibility_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: doubles_pair doubles_pair_player1_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_pair
    ADD CONSTRAINT doubles_pair_player1_id_fkey FOREIGN KEY (player1_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: doubles_pair doubles_pair_player2_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_pair
    ADD CONSTRAINT doubles_pair_player2_id_fkey FOREIGN KEY (player2_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: doubles_pair doubles_pair_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_pair
    ADD CONSTRAINT doubles_pair_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: doubles_request doubles_request_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_request
    ADD CONSTRAINT doubles_request_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: doubles_request doubles_request_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_request
    ADD CONSTRAINT doubles_request_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: doubles_request doubles_request_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doubles_request
    ADD CONSTRAINT doubles_request_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: email_message email_message_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message
    ADD CONSTRAINT email_message_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE SET NULL;


--
-- Name: import_batch import_batch_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batch
    ADD CONSTRAINT import_batch_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: import_row import_row_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_row
    ADD CONSTRAINT import_row_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batch(id) ON DELETE CASCADE;


--
-- Name: late_entry late_entry_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.late_entry
    ADD CONSTRAINT late_entry_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: late_entry late_entry_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.late_entry
    ADD CONSTRAINT late_entry_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: late_entry late_entry_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.late_entry
    ADD CONSTRAINT late_entry_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: official_site_distance official_site_distance_official_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_site_distance
    ADD CONSTRAINT official_site_distance_official_id_fkey FOREIGN KEY (official_id) REFERENCES public.official(id) ON DELETE CASCADE;


--
-- Name: official_site_distance official_site_distance_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.official_site_distance
    ADD CONSTRAINT official_site_distance_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id) ON DELETE CASCADE;


--
-- Name: pairing_avoidance_member pairing_avoidance_member_pairing_avoidance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance_member
    ADD CONSTRAINT pairing_avoidance_member_pairing_avoidance_id_fkey FOREIGN KEY (pairing_avoidance_id) REFERENCES public.pairing_avoidance(id) ON DELETE CASCADE;


--
-- Name: pairing_avoidance_member pairing_avoidance_member_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance_member
    ADD CONSTRAINT pairing_avoidance_member_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: pairing_avoidance pairing_avoidance_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance
    ADD CONSTRAINT pairing_avoidance_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: pairing_avoidance pairing_avoidance_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pairing_avoidance
    ADD CONSTRAINT pairing_avoidance_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: player_hotel_stay player_hotel_stay_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_hotel_stay
    ADD CONSTRAINT player_hotel_stay_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotel(id);


--
-- Name: player_hotel_stay player_hotel_stay_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_hotel_stay
    ADD CONSTRAINT player_hotel_stay_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: player_hotel_stay player_hotel_stay_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_hotel_stay
    ADD CONSTRAINT player_hotel_stay_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: player_hotel_stay player_hotel_stay_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_hotel_stay
    ADD CONSTRAINT player_hotel_stay_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: room_block room_block_hotel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_block
    ADD CONSTRAINT room_block_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotel(id) ON DELETE CASCADE;


--
-- Name: room_block room_block_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_block
    ADD CONSTRAINT room_block_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE SET NULL;


--
-- Name: scheduling_avoidance scheduling_avoidance_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_avoidance
    ADD CONSTRAINT scheduling_avoidance_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: scheduling_avoidance scheduling_avoidance_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_avoidance
    ADD CONSTRAINT scheduling_avoidance_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: scheduling_avoidance scheduling_avoidance_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_avoidance
    ADD CONSTRAINT scheduling_avoidance_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: session session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.user_account(id) ON DELETE CASCADE;


--
-- Name: tournament_entry tournament_entry_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_entry
    ADD CONSTRAINT tournament_entry_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: tournament_entry tournament_entry_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_entry
    ADD CONSTRAINT tournament_entry_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: tournament_site tournament_site_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_site
    ADD CONSTRAINT tournament_site_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.site(id) ON DELETE CASCADE;


--
-- Name: tournament_site tournament_site_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_site
    ADD CONSTRAINT tournament_site_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: tshirt_order tshirt_order_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tshirt_order
    ADD CONSTRAINT tshirt_order_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- Name: user_account user_account_official_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_account
    ADD CONSTRAINT user_account_official_id_fkey FOREIGN KEY (official_id) REFERENCES public.official(id) ON DELETE CASCADE;


--
-- Name: withdrawal withdrawal_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.withdrawal
    ADD CONSTRAINT withdrawal_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.player(id) ON DELETE CASCADE;


--
-- Name: withdrawal withdrawal_source_email_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.withdrawal
    ADD CONSTRAINT withdrawal_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.email_message(id) ON DELETE SET NULL;


--
-- Name: withdrawal withdrawal_tournament_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.withdrawal
    ADD CONSTRAINT withdrawal_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournament(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict fGvUV25h8R2C1E2eYM9pNhfejyqP1dPMwy0IY6d07fLYZSbrkreIm8ozcTgTmy9

